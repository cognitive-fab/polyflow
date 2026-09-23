// P4.4 — the version gate end to end: runs in flight on v1, a gate workflow
// vets v2 against their live states, migrates them, and a v2 worker carries
// them on — where the new CANCEL action now works (FR-VER.1–.3).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import { PolyflowPlugin, memorySink, startGoverned, loadMachineDir } from '../src/index.mjs';
import { startEnv, fixtures, quiet } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const examples = fileURLToPath(new URL('../../../examples/', import.meta.url));
const V1 = `${examples}customer-brief`;
const V2 = `${examples}customer-brief-v2`;
const { descriptor } = loadMachineDir(V1);

/** An approval that waits for a person — and notices when it is called off. */
const approvals = { answer: null };
const activities = {
  fetch_tickets: async () => ({ count: 3 }),
  draft_brief: async () => ({}),
  request_approval: async () => {
    for (;;) {
      if (approvals.answer) return approvals.answer;
      Context.current().heartbeat();
      await Context.current().sleep(100); // throws when the workflow calls the order off
    }
  },
  post_brief: async () => ({}),
};

const worker = (dir, taskQueue) => Worker.create({
  connection: env.nativeConnection, taskQueue, workflowsPath: `${fixtures}governed-workflows.mjs`, activities, maxCachedWorkflows: 0,
  bundlerOptions: { logger: quiet },
  plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': dir }, allowUncertified: true, gate: { client: env.client } })],
});

const until = async (fn, what) => {
  for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}`);
};

test('a v2 with a new action is gated against the v1 fleet, migrated, and carried on by a v2 worker', async () => {
  const q = 'gate-a';
  const v1 = await worker(V1, q);
  const runs = await v1.runUntil(async () => {
    const a = await startGoverned(env.client, { descriptor, input: { date: '2026-04-01' }, taskQueue: q, workflowExecutionTimeout: '5 minutes' });
    const b = await startGoverned(env.client, { descriptor, input: { date: '2026-04-02' }, taskQueue: q, workflowExecutionTimeout: '5 minutes' });
    for (const r of [a, b]) await until(async () => (await r.handle.query('polyflow.state')).state.briefState === 'review', 'review');
    // Under v1 there is no way to call a run off.
    await assert.rejects(a.handle.executeUpdate('polyflow.propose', { args: [{ action: 'CANCEL' }] }), (e) => /not in the machine's action surface/.test(`${e.message} ${e.cause?.message}`));
    const report = await env.client.workflow.execute('PolyflowGateWorkflow', {
      taskQueue: q, workflowId: 'gate-a-run', args: [{ machine: 'customer-brief', oldDir: V1, newDir: V2, toBuildId: 'v2' }], workflowExecutionTimeout: '5 minutes',
    });
    assert.deepEqual(report.counts, { migrate: 2 });
    assert.ok(report.lanes.includes('vocabulary'));
    assert.deepEqual(report.applied, { migrated: 2, upgrading: 0, recorded: 0, stale: [] });
    // Both runs handed over: a new execution each, waiting for a v2 worker.
    for (const r of [a, b]) await until(async () => (await env.client.workflow.getHandle(r.workflowId).describe()).runId !== r.handle.firstExecutionRunId, 'continue-as-new');
    return [a, b];
  });

  const v2 = await worker(V2, q);
  await v2.runUntil(async () => {
    const [a, b] = runs.map((r) => env.client.workflow.getHandle(r.workflowId));
    const sa = await until(async () => { try { return await a.query('polyflow.state'); } catch { return null; } }, 'v2 state');
    assert.equal(sa.state.briefState, 'review', 'the migrated state carried over');
    assert.deepEqual(sa.orders.map((o) => o.kind), ['request_approval'], 'the open approval was re-issued under the same order id');
    // v2's new action works on a run that started under v1.
    const r = await a.executeUpdate('polyflow.propose', { args: [{ action: 'CANCEL' }] });
    assert.equal(r.stepKind, 'accepted');
    assert.equal((await a.result()).state.briefState, 'cancelled');
    // The other run is approved and posts, once.
    approvals.answer = {};
    assert.equal((await b.result()).state.briefState, 'posted');
  });
});

test('the gate refuses an empty fleet rather than passing it', async () => {
  const q = 'gate-b';
  const w = await worker(V1, q);
  await w.runUntil(async () => {
    await assert.rejects(
      env.client.workflow.execute('PolyflowGateWorkflow', { taskQueue: q, workflowId: 'gate-b-run', args: [{ machine: 'nothing-runs-this', oldDir: V1, newDir: V2 }], workflowExecutionTimeout: '2 minutes' }),
      (e) => /the fleet is empty/.test(`${e.message} ${e.cause?.message}`),
    );
  });
});
