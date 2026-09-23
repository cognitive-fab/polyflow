// P9 acceptance evidence (functional spec §6):
//
//   S3    the double-post class is eliminated: a scheduled job that fires 8
//         times for one day posts 8 times on plain Temporal, and once governed
//   NFR-13 billable overhead: what the plugin adds to a workflow's Actions,
//         counted from the history, fixed per execution
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import proto from '@temporalio/proto';
const { temporal } = proto;
import { PolyflowPlugin, memorySink, startGoverned, loadMachineDir } from '../src/index.mjs';
import { startEnv, fixtures, quiet, agentActivities } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const { descriptor } = loadMachineDir(BRIEF);
const FIRES = 8;

test('S3: a job that fires 8 times for one day posts 8 times on plain Temporal, and once governed', async () => {
  let posts = 0;
  const activities = {
    fetch_tickets: async () => ({ count: 2 }), draft_brief: async () => ({}), request_approval: async () => ({}),
    post_brief: async () => { posts++; return {}; },
  };
  // Plain Temporal: the scheduler (or an agent) names each fire; each is a new run.
  const plain = await Worker.create({ connection: env.nativeConnection, taskQueue: 's3-plain', workflowsPath: `${fixtures}brief-plain.mjs`, activities, bundlerOptions: { logger: quiet } });
  await plain.runUntil(async () => {
    for (let i = 0; i < FIRES; i++) {
      await env.client.workflow.execute('briefPlain', { taskQueue: 's3-plain', workflowId: `brief-2026-09-22-fire-${i}`, args: [{ date: '2026-09-22' }], workflowExecutionTimeout: '60s' });
    }
  });
  const plainPosts = posts;
  posts = 0;
  // Governed: the run's identity is derived from the input; a finished run says so.
  const gov = await Worker.create({
    connection: env.nativeConnection, taskQueue: 's3-gov', workflowsPath: `${fixtures}governed-workflows.mjs`, activities, bundlerOptions: { logger: quiet },
    plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF }, allowUncertified: true })],
  });
  const statuses = await gov.runUntil(async () => {
    const out = [];
    for (let i = 0; i < FIRES; i++) {
      const r = await startGoverned(env.client, { descriptor, input: { date: '2026-09-22' }, taskQueue: 's3-gov', workflowExecutionTimeout: '60s' });
      out.push(r.status);
      await r.handle.result();
    }
    return out;
  });
  assert.equal(plainPosts, FIRES, 'without governance, every fire posts');
  assert.equal(posts, 1, 'governed, exactly one post across all fires');
  assert.deepEqual(statuses, ['started', ...Array(FIRES - 1).fill('complete')]);
});

/**
 * Billable-Action-generating events in a history, per docs.temporal.io/cloud/actions
 * (checked 2026-09): starts (and Continue-as-New), activity schedules, timers,
 * search-attribute upserts, signals, and Updates (accepted AND rejected). A memo
 * upsert is NOT billed. Queries ARE billed but leave no event: governance adds
 * none to an agent loop (a person answering an escalation is one Update, the
 * same as any approval mechanism). Rejected Updates leave no event either.
 */
function actions(history) {
  let n = 0;
  for (const e of history.events) {
    if (e.workflowExecutionStartedEventAttributes) n++;
    if (e.activityTaskScheduledEventAttributes) n++;
    if (e.upsertWorkflowSearchAttributesEventAttributes) n++;
    if (e.timerStartedEventAttributes) n++;
    if (e.workflowExecutionSignaledEventAttributes) n++;
    if (e.workflowExecutionUpdateAcceptedEventAttributes) n++;
  }
  return n;
}

test('NFR-13: governance adds a fixed number of Actions per execution — measured, not asserted', async () => {
  const bytes = {};
  const run = async (id, plugins) => {
    const w = await Worker.create({ connection: env.nativeConnection, taskQueue: id, workflowsPath: `${fixtures}agent-workflows.mjs`, activities: agentActivities, plugins, bundlerOptions: { logger: quiet } });
    await w.runUntil(env.client.workflow.execute('agentLoop', { taskQueue: id, workflowId: id, args: [{ steps: 10 }], workflowExecutionTimeout: '60s' }));
    const history = await env.client.workflow.getHandle(id).fetchHistory();
    // History size as the server stores it (protobuf), which counts against the 50 MB limit and is billed as storage.
    bytes[id] = temporal.api.history.v1.History.encode(history).finish().length;
    return actions(history);
  };
  const base = await run('cost-base', []);
  const guard = { policy: 'p', version: 1, effects: { think: { kind: 'think' }, search: { kind: 'search' }, post: { kind: 'post', class: 'irreversible' } }, rules: [{ id: 'one-post', type: 'at-most', guards: 'post', n: 1 }] };
  const byDefault = await run('cost-default', [new PolyflowPlugin({ level: 'guard', policy: guard, sink: memorySink() })]);
  const withMemo = await run('cost-memo', [new PolyflowPlugin({ level: 'guard', policy: guard, sink: memorySink(), memo: true })]);
  const sealed = await run('cost-sealed', [new PolyflowPlugin({ level: 'guard', policy: guard, sink: memorySink(), headerKey: { keyId: 'k', key: Buffer.alloc(32, 1).toString('base64') } })]);
  const pct = (n) => +((100 * (n - base)) / base).toFixed(1);
  const report = {
    baseline: base, governed: byDefault, governedWithMemo: withMemo,
    pct: pct(byDefault), pctWithMemo: pct(withMemo),
    // The overhead is a fixed +1 Action per EXECUTION (the closing flush): under 10% from 11 Actions.
    breakEven: 11,
    historyBytes: {
      baseline: bytes['cost-base'], governed: bytes['cost-default'], sealed: bytes['cost-sealed'],
      ratio: +(bytes['cost-default'] / bytes['cost-base']).toFixed(1), ratioSealed: +(bytes['cost-sealed'] / bytes['cost-base']).toFixed(1),
      perActivity: Math.round((bytes['cost-default'] - bytes['cost-base']) / 11), perActivitySealed: Math.round((bytes['cost-sealed'] - bytes['cost-base']) / 11),
    },
    notCounted: 'flush retries (at most 5, on sink failure only); heartbeats of external-agent orders (billed as the customer configures them); queries an operator or the gate sends (billed, not in this loop)',
  };
  console.log(`[NFR-13] ${JSON.stringify(report)}`);
  assert.equal(byDefault - base, 1, 'by default, one flush per execution carries the closure');
  assert.equal(withMemo - base, 1, 'a memo upsert is not a billable Action');
  assert.ok(report.pct < 10, `a 10-step agent loop pays ${report.pct}% at the default configuration`);
});
