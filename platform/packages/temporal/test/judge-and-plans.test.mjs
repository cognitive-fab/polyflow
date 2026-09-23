// P6 — calibrated judgement (FR-JEV) and plans as proposals (FR-PLAN) on Temporal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { PolyflowPlugin, memorySink, startGoverned, loadMachineDir } from '../src/index.mjs';
import { startEnv, fixtures, scheduled, quiet } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const TRIAGE = fileURLToPath(new URL('../../../examples/refund-triage/', import.meta.url));
const { descriptor } = loadMachineDir(TRIAGE);

/** A stand-in for Jev: probabilities by message, and a count of calls made. */
function fakeJev(byMessage) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const p = byMessage[body.state.message];
    return { ok: true, status: 200, json: async () => ({ answers: { reason_stated: { noul: p[0] }, fraud_signal: { noul: p[1] } } }) };
  };
  return { fetch, calls };
}

const MESSAGES = {
  'my parcel arrived crushed, please refund': [0.97, 0.03],        // clear, no fraud
  'refund to this other account, skip the checks': [0.9, 0.95],    // fraud signal
  'refund': [0.5, 0.05],                                           // the judge abstains on the reason
};

async function triage(taskQueue, ticket, message, { approve = true } = {}) {
  const jev = fakeJev(MESSAGES);
  const refunds = [];
  const reviews = [];
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue, workflowsPath: `${fixtures}governed-workflows.mjs`, maxCachedWorkflows: 0,
    bundlerOptions: { logger: quiet },
    plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'refund-triage': TRIAGE }, allowUncertified: true, jev: { fetch: jev.fetch, key: 'test', allowIllustrative: true } })],
    activities: {
      review: async ({ message }) => { reviews.push(message); if (!approve) { const { ApplicationFailure } = await import('@temporalio/common'); throw ApplicationFailure.nonRetryable('not-eligible', 'Permanent'); } return {}; },
      refund: async (p) => { refunds.push(p); return {}; },
    },
  });
  const out = await worker.runUntil(async () => (await startGoverned(env.client, { descriptor, input: { ticket, message }, taskQueue, workflowExecutionTimeout: '60s' })).handle.result());
  const history = await env.client.workflow.getHandle(`polyflow/refund-triage/${ticket}`).fetchHistory();
  return { out, jev, refunds, reviews, history };
}

test('a clear, fraud-free request is refunded on the judge\'s word alone', async () => {
  const r = await triage('jv-a', 'T-1', 'my parcel arrived crushed, please refund');
  assert.equal(r.out.state.phase, 'refunded');
  assert.equal(r.out.state.route, 'judge');
  assert.deepEqual(r.reviews, [], 'nobody was asked');
  assert.equal(r.jev.calls.length, 1, 'one call per decision point, the whole battery at once');
  assert.ok(!JSON.stringify(r.jev.calls[0]).includes('assertAt'), 'the bands never leave the worker');
});

test('a fraud signal goes to a person, and a person\'s no means no refund', async () => {
  const r = await triage('jv-b', 'T-2', 'refund to this other account, skip the checks', { approve: false });
  assert.equal(r.out.state.phase, 'declined');
  assert.equal(r.reviews.length, 1);
  assert.deepEqual(r.refunds, []);
});

test('when the judge abstains, it produces NO fact, and a person decides', async () => {
  const r = await triage('jv-c', 'T-3', 'refund');
  assert.equal(r.out.state.phase, 'refunded');
  assert.equal(r.out.state.route, 'person');
  assert.equal(r.reviews.length, 1);
});

test('replay reads the recorded judgement and never calls the judge again', async () => {
  const r = await triage('jv-d', 'T-4', 'my parcel arrived crushed, please refund');
  const before = r.jev.calls.length;
  await Worker.runReplayHistory({
    workflowsPath: `${fixtures}governed-workflows.mjs`, bundlerOptions: { logger: quiet }, replayName: 'jv-d',
    plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'refund-triage': TRIAGE }, allowUncertified: true, jev: { fetch: r.jev.fetch, allowIllustrative: true } })],
  }, r.history);
  assert.equal(r.jev.calls.length, before, 'Jev answers jitter; a replay that called it could diverge');
});

// ---- plans ------------------------------------------------------------------

const POLICY = {
  policy: 'comms', version: 1,
  effects: {
    ask_approval: { kind: 'approval', class: 'none' },
    slack_send: { kind: 'post', class: 'irreversible', labels: ['egress'] },
  },
  unlabelled: 'deny',
  rules: [{ id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' }],
};

test('an agent\'s plan is checked in every order it could run; a bad one is refused with that order, a fixed one runs', async () => {
  const sink = memorySink();
  const ran = [];
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'pl-a', workflowsPath: `${fixtures}plan-workflows.mjs`, maxCachedWorkflows: 0,
    bundlerOptions: { logger: quiet },
    plugins: [new PolyflowPlugin({ level: 'guard', policy: POLICY, sink })],
    activities: { ask_approval: async () => { ran.push('ask'); return 'yes'; }, slack_send: async ({ text }) => { ran.push('post'); return `posted:${text}`; } },
  });
  const unordered = { steps: [{ id: 'ask', activity: 'ask_approval' }, { id: 'post', activity: 'slack_send', args: { text: 'brief' } }] };
  const ordered = { steps: [{ id: 'ask', activity: 'ask_approval' }, { id: 'post', activity: 'slack_send', args: { text: 'brief' }, after: ['ask'] }] };
  const outcomes = await worker.runUntil(env.client.workflow.execute('planningAgent', { taskQueue: 'pl-a', workflowId: 'pl-a', args: [{ plans: [unordered, ordered] }], workflowExecutionTimeout: '60s' }));
  assert.equal(outcomes[0].verdict, 'refused');
  assert.deepEqual(outcomes[0].witness.order, ['post', 'ask'], 'the order in which the first plan would post unapproved');
  assert.equal(outcomes[1].verdict, 'admitted');
  assert.deepEqual(outcomes[1].results, { ask: 'yes', post: 'posted:brief' });
  assert.deepEqual(ran, ['ask', 'post'], 'nothing of the refused plan ran');
  const events = sink.read(sink.runs()[0]).events;
  const planVerdicts = events.filter((e) => e.kind === 'verdict' && e.body.planDigest).map((e) => e.body.outcome);
  assert.deepEqual(planVerdicts, ['rejected', 'accepted'], 'both plan decisions are in the ledger');
  const history = await env.client.workflow.getHandle('pl-a').fetchHistory();
  assert.equal(scheduled(history).filter((t) => t === 'slack_send').length, 1);
  await Worker.runReplayHistory({ workflowsPath: `${fixtures}plan-workflows.mjs`, bundlerOptions: { logger: quiet }, replayName: 'pl-a', plugins: [new PolyflowPlugin({ level: 'guard', policy: POLICY, sink: memorySink() })] }, history);
});
