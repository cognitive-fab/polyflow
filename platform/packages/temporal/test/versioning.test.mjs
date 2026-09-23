// P4.4 / FR-VER.2, FR-VER.6, FR-ADM.6 — the version gate on Temporal Worker
// Versioning (P4/P5 review VG1). Two certified versions, each on its own
// worker deployment version whose build id IS its certificate. The gate vets
// v2 against the v1 fleet BEFORE promotion; the runs it moves wait, pinned to
// v1, until v2 is current; the wake phase lets each continue as new onto v2
// (Upgrade-on-Continue-as-New), carrying the migrated state and its open order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import { admit } from '@cognitive-fab/polyflow-cli/src/admit.mjs';
import { PolyflowPlugin, memorySink, startGoverned, loadMachineDir, generateSigningKey } from '../src/index.mjs';
import { startEnv, fixtures, quiet } from './helpers.mjs';

let env;
const made = [];
before(async () => { env = await startEnv(); });
after(async () => {
  await env?.teardown();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const examples = fileURLToPath(new URL('../../../examples/', import.meta.url));
const key = generateSigningKey('vg-test');
const trust = { [key.keyId]: key.publicKeyPem };

async function certified(name) {
  const dir = mkdtempSync(join(examples, '.tmp-vg-'));
  made.push(dir);
  cpSync(join(examples, name), dir, { recursive: true });
  const r = await admit(dir, { key });
  assert.ok(r.ok, JSON.stringify(r.problems));
  return dir;
}

const approvals = { answer: null };
const activities = {
  fetch_tickets: async () => ({ count: 3 }),
  draft_brief: async () => ({}),
  request_approval: async () => {
    for (;;) {
      if (approvals.answer) return approvals.answer;
      Context.current().heartbeat();
      await Context.current().sleep(100); // throws when the order is called off at the hand-over
    }
  },
  post_brief: async () => ({}),
};

const DEPLOYMENT = 'polyflow-brief';
async function versionedWorker(dir, taskQueue) {
  const plugin = new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': dir }, trust, gate: { client: env.client } });
  const buildId = plugin.buildId();
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue, workflowsPath: `${fixtures}governed-workflows.mjs`, activities, maxCachedWorkflows: 0,
    bundlerOptions: { logger: quiet },
    workerDeploymentOptions: { useWorkerVersioning: true, version: { deploymentName: DEPLOYMENT, buildId }, defaultVersioningBehavior: 'PINNED' },
    plugins: [plugin],
  });
  return { worker, buildId, running: worker.run() };
}

const until = async (fn, what, n = 300) => {
  for (let i = 0; i < n; i++) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`timed out waiting for ${what}`);
};

async function setCurrent(buildId) {
  // The server learns a version from its pollers: retry until it has.
  await until(async () => {
    await env.client.workflowService.setWorkerDeploymentCurrentVersion({ namespace: 'default', deploymentName: DEPLOYMENT, buildId });
    return true;
  }, `version ${buildId} to become current`, 100);
}

test('a gated run waits on v1, and continues as new onto v2 when v2 becomes current', async () => {
  const q = 'vg-e2e';
  const V1 = await certified('customer-brief');
  const V2 = await certified('customer-brief-v2');
  const { descriptor } = loadMachineDir(V1);
  const w1 = await versionedWorker(V1, q);
  const w2 = await versionedWorker(V2, q);
  assert.notEqual(w1.buildId, w2.buildId, 'two certificates, two versions');
  try {
    await setCurrent(w1.buildId);
    const { handle, workflowId } = await startGoverned(env.client, { descriptor, input: { date: '2026-05-01' }, taskQueue: q, workflowExecutionTimeout: '5 minutes' });
    await until(async () => (await handle.query('polyflow.state')).state.briefState === 'review', 'review');
    const firstRun = handle.firstExecutionRunId;

    // Before promotion: vet v2 against the runs on v1, and tell them.
    const report = await env.client.workflow.execute('PolyflowGateWorkflow', {
      taskQueue: q, workflowId: 'vg-gate-1', workflowExecutionTimeout: '5 minutes',
      args: [{ machine: 'customer-brief', oldDir: V1, newDir: V2, toBuildId: w2.buildId, fromBuildId: w1.buildId, onVersionChange: true }],
    });
    assert.deepEqual(report.counts, { migrate: 1 });
    assert.equal(report.applied.migrated, 1);

    // Not promoted yet: the run stays where it is.
    await new Promise((r) => setTimeout(r, 1000));
    const g = env.client.workflow.getHandle(workflowId);
    assert.equal((await g.describe()).runId, firstRun, 'the run moved before the new version was current');
    assert.ok((await g.query('polyflow.state')).migrationPending?.onVersionChange);

    // Promote, then wake the runs that are waiting to move.
    await setCurrent(w2.buildId);
    const woke = await env.client.workflow.execute('PolyflowGateWorkflow', {
      taskQueue: q, workflowId: 'vg-gate-wake', workflowExecutionTimeout: '2 minutes', args: [{ machine: 'customer-brief', phase: 'wake' }],
    });
    assert.equal(woke.woken, 1);

    await until(async () => (await g.describe()).runId !== firstRun, 'the hand-over');
    const d = await g.describe();
    const now = d.raw.workflowExecutionInfo?.versioningInfo;
    const on = now?.deploymentVersion?.buildId ?? now?.version?.split('.').pop() ?? null;
    assert.equal(on, w2.buildId, `the next execution runs on v2 (versioning info: ${JSON.stringify(now)})`);
    const s = await until(async () => { const x = await g.query('polyflow.state'); return x.orders.length ? x : null; }, 'the carried order');
    assert.equal(s.state.briefState, 'review', 'the migrated state carried over');
    assert.equal(s.certificate.buildId, w2.buildId, 'answered by the v2 machine');
    // v2's new action works on a run that started under v1.
    const r = await g.executeUpdate('polyflow.propose', { args: [{ action: 'CANCEL' }] });
    assert.equal(r.stepKind, 'accepted');
    assert.equal((await g.result()).state.briefState, 'cancelled');
  } finally {
    approvals.answer = {};
    w1.worker.shutdown();
    w2.worker.shutdown();
    await Promise.allSettled([w1.running, w2.running]);
  }
});
