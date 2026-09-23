// P4.6 — the policy ramp gate: a G1 policy change is vetted against the guard
// state of every run in flight BEFORE workers carrying it are promoted. A run
// that is allowed an effect now, and would be denied it under the new policy
// from the same state, is pinned; the gate refuses the ramp and says which.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from '@temporalio/worker';
import { admitPolicy, vetPolicyChange, createGuard, classify } from '@cognitive-fab/polyflow-kernel';
import { PolyflowPlugin, memorySink } from '../src/index.mjs';
import { startEnv, fixtures, quiet } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const OLD = {
  policy: 'comms', version: 1,
  effects: { slack_send: { kind: 'post', class: 'irreversible', labels: ['egress'] }, ask_approval: { kind: 'approval', class: 'none' } },
  rules: [{ id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' }, { id: 'one-post', type: 'at-most', guards: 'post', n: 1 }],
};
// v2 also wants a manager's sign-off before a post: a run that holds an
// approval, and was about to post, is allowed something v2 takes back.
const NEW = {
  ...OLD, version: 2,
  effects: { ...OLD.effects, ask_manager: { kind: 'manager', class: 'none' } },
  rules: [...OLD.rules, { id: 'manager-before-post', type: 'requires-prior', guards: 'post', prior: 'manager' }],
};

test('the kernel pins a run the new policy would take an allowed effect from, and moves the others', () => {
  const oldP = admitPolicy(OLD);
  const g = createGuard(oldP);
  const c = { ...classify(oldP, 'ask_approval'), target: 'ask_approval', argsDigest: 'd', at: 1 };
  const approved = g.observe(g.commit(g.init(), c, g.decide(g.init(), c)), { kind: 'approval', ok: true });
  const r = vetPolicyChange(oldP, admitPolicy(NEW), [{ workflowId: 'a', guard: approved, at: 2 }, { workflowId: 'b', guard: g.init(), at: 2 }]);
  assert.deepEqual(r.decisions, [{ workflowId: 'a', decision: 'pin', revoked: ['slack_send'] }, { workflowId: 'b', decision: 'move', revoked: [] }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.freshRules, ['manager-before-post'], 'a new consuming prior counts credits from zero, and is reported (RP4)');
});

test('the gate reads each run\'s guard state by query and refuses the ramp, naming the run', async () => {
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'ramp', workflowsPath: `${fixtures}ramp-workflows.mjs`, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
    activities: { ask_approval: async () => ({}), slack_send: async () => 'posted' },
    plugins: [new PolyflowPlugin({ level: 'guard', policy: OLD, sink: memorySink(), gate: { client: env.client } })],
  });
  await worker.runUntil(async () => {
    const a = await env.client.workflow.start('approveThenPost', { taskQueue: 'ramp', workflowId: 'ramp-a', args: [{ approvals: 1 }], workflowExecutionTimeout: '60s' });
    const b = await env.client.workflow.start('approveThenPost', { taskQueue: 'ramp', workflowId: 'ramp-b', args: [{ approvals: 0 }], workflowExecutionTimeout: '60s' });
    for (let i = 0; i < 100; i++) { const g = await a.query('polyflow.guard'); if (g.guard?.n?.approval === 1) break; await new Promise((r) => setTimeout(r, 100)); }
    const query = "WorkflowType = 'approveThenPost'";
    // Visibility is eventually consistent: wait until both runs are listed.
    for (let i = 0; i < 100; i++) { let n = 0; for await (const _ of env.client.workflow.list({ query: `ExecutionStatus = 'Running' AND ${query}` })) n++; if (n === 2) break; await new Promise((r) => setTimeout(r, 100)); }
    const refused = await env.client.workflow.execute('PolyflowPolicyGateWorkflow', { taskQueue: 'ramp', workflowId: 'ramp-gate-1', args: [{ oldPolicy: OLD, newPolicy: NEW, query }], workflowExecutionTimeout: '60s' })
      .then(() => null, (e) => e);
    assert.ok(refused, 'the ramp was refused');
    const details = refused.cause.details?.[0];
    assert.ok(details?.decisions, `gate failed for another reason: ${refused.cause?.message} ${JSON.stringify(details).slice(0, 300)}`);
    assert.deepEqual(details.decisions.map((d) => [d.workflowId, d.decision]).sort(), [['ramp-a', 'pin'], ['ramp-b', 'move']]);
    assert.match(refused.cause.message, /ramp-a \(slack_send\)/);
    // A change that takes nothing back passes.
    const looser = { ...OLD, version: 3, rules: [OLD.rules[0]] };
    const ok = await env.client.workflow.execute('PolyflowPolicyGateWorkflow', { taskQueue: 'ramp', workflowId: 'ramp-gate-2', args: [{ oldPolicy: OLD, newPolicy: looser, query }], workflowExecutionTimeout: '60s' });
    assert.deepEqual(ok.counts, { move: 2 });
    for (const h of [a, b]) { await h.signal('go'); await h.result().catch(() => null); }
  });
});
