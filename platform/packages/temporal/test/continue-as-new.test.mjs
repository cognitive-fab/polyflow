// P3.4 — a governed run continues as new mid-flight, carrying its state, its
// open order and its armed timer, and ends exactly as it would have without
// the hand-over: same final state, one post (P2/P3 review CN1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import { PolyflowPlugin, memorySink, startGoverned, loadMachineDir } from '../src/index.mjs';
import { startEnv, fixtures, scheduled, quiet } from './helpers.mjs';
import { digest } from '@cognitive-fab/polyflow-kernel';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const { descriptor } = loadMachineDir(BRIEF);

test('continue-as-new mid-run keeps the state, re-issues the open order, re-arms the timer, and posts once', async () => {
  let posts = 0;
  const approval = { answer: null, calls: 0 };
  const w = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'can-a', workflowsPath: `${fixtures}governed-workflows.mjs`, maxCachedWorkflows: 0,
    bundlerOptions: { logger: quiet },
    plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF }, allowUncertified: true })],
    activities: {
      fetch_tickets: async () => ({ count: 2 }),
      draft_brief: async () => ({}),
      request_approval: async (_payload, meta) => {
        approval.calls += 1;
        approval.orderIds = [...(approval.orderIds ?? []), meta.orderId];
        for (;;) {
          if (approval.answer) return approval.answer;
          Context.current().heartbeat();
          await Context.current().sleep(100);
        }
      },
      post_brief: async () => { posts += 1; return {}; },
    },
  });
  const out = await w.runUntil(async () => {
    const { handle, workflowId } = await startGoverned(env.client, { descriptor, input: { date: '2026-05-01' }, taskQueue: 'can-a', workflowExecutionTimeout: '2 minutes' });
    for (let i = 0; i < 200 && approval.calls === 0; i++) await new Promise((r) => setTimeout(r, 50));
    const before = await handle.query('polyflow.state');
    assert.equal(before.state.briefState, 'review');
    // An identity migration: the state is unchanged, the hand-over is real.
    await handle.executeUpdate('polyflow.migrate', { args: [{ snapshot: before.state, from: digest(before.state) }] });
    const first = handle.firstExecutionRunId;
    let now;
    for (let i = 0; i < 200; i++) { now = await env.client.workflow.getHandle(workflowId).describe(); if (now.runId !== first) break; await new Promise((r) => setTimeout(r, 50)); }
    assert.notEqual(now.runId, first, 'the run continued as new');
    const after = await env.client.workflow.getHandle(workflowId).query('polyflow.state');
    assert.deepEqual(after.state, before.state);
    assert.deepEqual(after.timers.map((t) => [t.key, t.fireAt]), before.timers.map((t) => [t.key, t.fireAt]), 'the approval window is re-armed at the same fire time');
    assert.deepEqual(after.orders.map((o) => o.orderId), before.orders.map((o) => o.orderId), 'the open order is re-issued under the same id');
    approval.answer = {};
    return env.client.workflow.getHandle(workflowId).result();
  });
  assert.equal(out.state.briefState, 'posted');
  assert.equal(posts, 1);
  assert.equal(new Set(approval.orderIds).size, 1, 'both offers of the approval carried the same order id');
});

test('a snapshot handed to a fresh start is refused: state crosses only a Continue-as-New', async () => {
  const w = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'can-b', workflowsPath: `${fixtures}governed-workflows.mjs`, maxCachedWorkflows: 0,
    bundlerOptions: { logger: quiet },
    plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF }, allowUncertified: true })],
    activities: { fetch_tickets: async () => ({ count: 1 }), draft_brief: async () => ({}), request_approval: async () => ({}), post_brief: async () => ({}) },
  });
  const outcome = await w.runUntil(env.client.workflow.execute('GovernedWorkflow', {
    taskQueue: 'can-b', workflowId: 'forged', workflowExecutionTimeout: '30s',
    args: [{ machine: 'customer-brief', snapshot: { briefState: 'posting', ticketCount: 1, reason: '' } }],
  }).then(() => 'ran', (e) => `${e.cause?.message ?? e.message}`));
  assert.match(outcome, /a snapshot is accepted only across Continue-as-New/);
  const history = await env.client.workflow.getHandle('forged').fetchHistory();
  assert.ok(!scheduled(history).includes('post_brief'));
});
