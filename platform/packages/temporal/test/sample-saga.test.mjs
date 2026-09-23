// P11 sample 3 — Temporal's `saga` sample (samples-typescript, pinned under
// examples/upstream) as a certified machine at G2, with a v2 (a KYC step and
// its compensation) promoted through vet and the gate under Worker Versioning,
// with no patched(). The sample's activities, clients and types are byte for
// byte upstream's, loaded as is (src/loader.mjs).
//
// (a) admission certifies v1 and v2 and names the compensation guarantees;
// (b) a mutation that compensates a step that never succeeded is REFUSED, by name;
// (c) the happy path opens the account: four steps, in order, once each;
// (d) the sample's own demo, a failure at addBankAccount: removeClient then
//     clearPostalAddresses, nothing else, ending `compensated`;
// (e) a compensation that fails for good ends `compensation_failed`, named;
// (f) vet v1 → v2 over a fleet in every distinct v1 state: none pinned;
// (g) an incompatible v3 (the address step removed) is pinned, and the gate refuses it;
// (h) end to end: a run parked in `adding_bank` on v1 is vetted, told, and when v2
//     is current continues as new onto v2, where its next order is addKycCheck;
//     the record is one chain across the hand-over;
// (i) a step in flight that does not heartbeat finishes where it started: the
//     hand-over waits for it, it runs once, and the run (moved on) stays on v1;
// (j) a person CANCELs a saga past its first steps: what succeeded is compensated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { admit } from '@cognitive-fab/polyflow-cli/src/admit.mjs';
import { PolyflowPlugin, memorySink, startGoverned, loadMachineDir, generateSigningKey, vet } from '../src/index.mjs';
import { verifyChain } from '@cognitive-fab/polyflow-kernel';
import { startEnv, scheduled, quiet } from './helpers.mjs';

const SAMPLE = fileURLToPath(new URL('../../../examples/temporal_samples/saga/', import.meta.url));
const V1 = join(SAMPLE, 'machine');
const V2 = join(SAMPLE, 'machine-v2');
const { descriptor } = loadMachineDir(V1);
register(new URL('src/loader.mjs', `file:///${SAMPLE.replace(/\\/g, '/')}`).href);
const { makeActivities } = await import(new URL('src/orders.mjs', `file:///${SAMPLE.replace(/\\/g, '/')}`).href);
const sample = await makeActivities();

let env;
const made = [];
before(async () => { env = await startEnv(); });
after(async () => {
  await env?.teardown();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const key = generateSigningKey('saga-ci');
const trust = { [key.keyId]: key.publicKeyPem };

const COMMAND = (accountId, failAt = '') => ({
  accountId, bankId: 'Foo Bar Savings and Loan', clientEmail: 'bart@simpson.io',
  address: { address1: '123 Temporal Street', postalCode: '98006' },
  bankDetails: { accountNumber: '111', routingNumber: '1234555', accountType: 'Checking', personalOwner: { firstName: 'Bart', lastName: 'Simpson' } },
  failAt,
});

function copyMachine(from, mutate) {
  const dir = mkdtempSync(join(fileURLToPath(new URL('../../../examples/', import.meta.url)), '.tmp-saga-'));
  made.push(dir);
  cpSync(from, dir, { recursive: true });
  rmSync(join(dir, 'polyflow.certificate.json'), { force: true });
  if (mutate) mutate(dir);
  return dir;
}
const edit = (dir, file, from, to) => {
  const p = join(dir, file);
  const text = readFileSync(p, 'utf8');
  assert.ok(text.includes(from), `${file} has "${from}"`);
  writeFileSync(p, text.replace(from, to));
};

async function worker(taskQueue, activities = sample, dir = V1) {
  return Worker.create({
    connection: env.nativeConnection, taskQueue, workflowsPath: join(SAMPLE, 'src', 'workflows.mjs'), activities,
    plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { saga: dir }, allowUncertified: true })],
    maxCachedWorkflows: 0, bundlerOptions: { logger: quiet }, defaultHeartbeatThrottleInterval: '200ms', maxHeartbeatThrottleInterval: '200ms',
  });
}
const start = (taskQueue, input) => startGoverned(env.client, { descriptor, input, taskQueue, workflowExecutionTimeout: '2 minutes' });
const steps = async (workflowId) => scheduled(await env.client.workflow.getHandle(workflowId).fetchHistory()).filter((t) => !t.startsWith('polyflow.'));
const until = async (fn, what, n = 300) => {
  for (let i = 0; i < n; i++) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`timed out waiting for ${what}`);
};

test('(a) admission certifies v1 and v2 and names the compensation guarantees', async () => {
  for (const dir of [copyMachine(V1), copyMachine(V2)]) {
    const r = await admit(dir, { key });
    assert.ok(r.ok, JSON.stringify(r.problems));
    for (const g of ['compensation-only-for-a-step-that-succeeded', 'no-forward-step-after-compensating-began', 'compensations-are-lifo', 'each-step-at-most-once']) {
      assert.ok(r.certificate.guarantees.includes(g), g);
    }
  }
});

test('(b) a machine that compensates a step that never succeeded is refused, by name', async () => {
  // A client failure now removes the client (never added) before clearing the address.
  const dir = copyMachine(V1, (d) => edit(d, 'machine.cjs', "forward('adding_client', 'addClient', 'adding_bank', 'undo_address')", "forward('adding_client', 'addClient', 'adding_bank', 'undo_client')"));
  const r = await admit(dir, { key });
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r.problems), /compensation-only-for-a-step-that-succeeded/);
  // A bank failure that clears the address but skips removing the client.
  const skip = copyMachine(V1, (d) => edit(d, 'machine.cjs', "forward('adding_bank', 'addBankAccount', 'opened', 'undo_client')", "forward('adding_bank', 'addBankAccount', 'opened', 'undo_address')"));
  const r2 = await admit(skip, { key });
  assert.equal(r2.ok, false);
  assert.match(JSON.stringify(r2.problems), /every-succeeded-step-is-compensated-first/);
  // A completion the machine accepts without its order: BANK_ADDED from adding_client opens the account with no bank step.
  const forged = copyMachine(V1, (d) => edit(d, 'machine.cjs', "      BANK_ADDED: bank.ok,", "      BANK_ADDED: (model) => (proposal, { reject, next, unchanged }) => { if (!['adding_bank', 'adding_client'].includes(model.phase)) return reject('stale-completion'); next.phase = 'opened'; unchanged('params', 'failedStep', 'reason'); },"));
  const r3 = await admit(forged, { key });
  assert.equal(r3.ok, false);
  assert.match(JSON.stringify(r3.problems), /no-completion-without-its-order/);
});

test('(c) the happy path opens the account: four steps, in order, once each', async () => {
  const w = await worker('saga-c');
  const out = await w.runUntil(async () => (await start('saga-c', COMMAND('saga-c-1'))).handle.result());
  assert.equal(out.state.phase, 'opened');
  assert.deepEqual(await steps('polyflow/saga/saga-c-1'), ['createAccount', 'addAddress', 'addClient', 'addBankAccount']);
});

test("(d) the sample's demo: addBankAccount fails, the client and the address are compensated, last first", async () => {
  const w = await worker('saga-d');
  const out = await w.runUntil(async () => (await start('saga-d', COMMAND('saga-d-1', 'addBankAccount'))).handle.result());
  assert.deepEqual([out.state.phase, out.state.failedStep], ['compensated', 'addBankAccount']);
  assert.deepEqual(await steps('polyflow/saga/saga-d-1'), ['createAccount', 'addAddress', 'addClient', 'addBankAccount', 'removeClient', 'clearPostalAddresses']);
});

test('(e) a compensation that fails for good ends the run compensation_failed, named (upstream swallowed it)', async () => {
  const w = await worker('saga-e', { ...sample, removeClient: async () => { throw ApplicationFailure.nonRetryable('clients service down', 'Permanent'); } });
  const out = await w.runUntil(async () => (await start('saga-e', COMMAND('saga-e-1', 'addBankAccount'))).handle.result());
  assert.deepEqual([out.state.phase, out.state.failedStep], ['compensation_failed', 'addBankAccount']);
  assert.match(out.state.reason, /clients service down/);
  assert.ok(!(await steps('polyflow/saga/saga-e-1')).includes('clearPostalAddresses'), 'compensation stopped where it failed');
});

const state = (phase, extra = {}) => ({ phase, params: COMMAND('fleet'), failedStep: '', reason: '', ...extra });
const FLEET = [
  { workflowId: 'polyflow/saga/f-1', state: state('creating_account'), openKinds: ['createAccount'] },
  { workflowId: 'polyflow/saga/f-2', state: state('adding_address'), openKinds: ['addAddress'] },
  { workflowId: 'polyflow/saga/f-3', state: state('adding_client'), openKinds: ['addClient'] },
  { workflowId: 'polyflow/saga/f-4', state: state('adding_bank'), openKinds: ['addBankAccount'] },
  { workflowId: 'polyflow/saga/f-5', state: state('undo_client', { failedStep: 'addBankAccount', reason: 'step-failed' }), openKinds: ['removeClient'] },
  { workflowId: 'polyflow/saga/f-6', state: state('undo_address', { failedStep: 'addClient', reason: 'step-failed' }), openKinds: ['clearPostalAddresses'] },
];

test('(f) vet v1 → v2 over a fleet in every live v1 state: every run upgrades or migrates, none is pinned', async () => {
  const v1 = copyMachine(V1); const v2 = copyMachine(V2);
  assert.ok((await admit(v1, { key })).ok); assert.ok((await admit(v2, { key })).ok);
  const r = vet({ oldDir: v1, newDir: v2, fleet: FLEET, trust });
  assert.ok(r.ok, JSON.stringify(r.decisions.map((d) => [d.workflowId, d.decision, d.failed]), null, 1));
  assert.equal(r.counts.pin ?? 0, 0);
  assert.equal(r.decisions.length, FLEET.length);
});

test('(g) an incompatible v3 (the address step removed) is pinned by vet, and the gate refuses it', async () => {
  const v1 = copyMachine(V1);
  assert.ok((await admit(v1, { key })).ok);
  // v3 drops the address step and its compensation altogether: the states, the
  // actions, the orders. A valid machine on its own, with no place for a run
  // that v1 parked in adding_address or undo_address, and no ear for the
  // completion their open orders will report.
  const v3 = copyMachine(V2, (d) => {
    edit(d, 'machine.cjs', "forward('creating_account', 'createAccount', 'adding_address', 'failed')", "forward('creating_account', 'createAccount', 'adding_client', 'failed')");
    edit(d, 'machine.cjs', "forward('adding_client', 'addClient', 'adding_bank', 'undo_address')", "forward('adding_client', 'addClient', 'adding_bank', 'failed')");
    edit(d, 'machine.cjs', "compensation('undo_client', 'undo_address')", "compensation('undo_client', 'compensated')");
    const gone = /ADDRESS_ADDED|ADDRESS_FAILED|ADDRESSES_CLEARED|ADDRESSES_CLEAR_FAILED|const address = |const undoAddress = |entered\('adding_address'\)|entered\('undo_address'\)/;
    for (const f of ['machine.cjs', 'effects.cjs']) {
      const p = join(d, f);
      writeFileSync(p, readFileSync(p, 'utf8').split('\n').filter((line) => !gone.test(line)).join('\n'));
    }
    for (const [f, key, names] of [['contract.json', 'actions', ['ADDRESS_ADDED', 'ADDRESS_FAILED', 'ADDRESSES_CLEARED', 'ADDRESSES_CLEAR_FAILED']], ['effects.manifest.json', 'effects', ['addAddress', 'clearPostalAddresses']]]) {
      const p = join(d, f);
      const j = JSON.parse(readFileSync(p, 'utf8'));
      for (const n of names) { delete j[key][n]; if (j.dataDomain) delete j.dataDomain[n]; }
      if (j.stateKeys) j.stateKeys[0].type = j.stateKeys[0].type.replace("'adding_address' | ", '').replace("'undo_address' | ", '');
      writeFileSync(p, JSON.stringify(j, null, 2));
    }
    edit(d, 'effect-invariants.mjs', "['createAccount', 'addAddress', 'addClient', 'addBankAccount', 'addKycCheck']", "['createAccount', 'addClient', 'addBankAccount', 'addKycCheck']");
    edit(d, 'effect-invariants.mjs', "['ACCOUNT_CREATED', 'ADDRESS_ADDED', 'CLIENT_ADDED', 'BANK_ADDED']", "['ACCOUNT_CREATED', 'CLIENT_ADDED', 'BANK_ADDED']");
    edit(d, 'effect-invariants.mjs', "const UNDO = { disconnectBankAccounts: 'BANK_ADDED', removeClient: 'CLIENT_ADDED', clearPostalAddresses: 'ADDRESS_ADDED' };", "const UNDO = { disconnectBankAccounts: 'BANK_ADDED', removeClient: 'CLIENT_ADDED' };");
    edit(d, 'effect-invariants.mjs', "[['clearPostalAddresses', 'CLIENT_ADDED', 'removeClient'], ['removeClient', 'BANK_ADDED', 'disconnectBankAccounts']]", "[['removeClient', 'BANK_ADDED', 'disconnectBankAccounts']]");
    edit(d, 'machine.cjs', "adding_client: { phase: 'undo_address', step: 'addClient' }, ", '');
    edit(d, 'machine.cjs', "if (!['idle', 'creating_account', 'adding_address'].includes(model.phase)) return reject('nothing-to-stop');", "if (!['idle', 'creating_account', 'adding_client'].includes(model.phase)) return reject('nothing-to-stop');");
    edit(d, 'invariants.mjs', "['createAccount', 'addAddress'].includes(s.failedStep)", "['createAccount', 'addClient'].includes(s.failedStep)");
    edit(d, 'invariants.mjs', "['addClient', 'addBankAccount', 'addKycCheck'].includes(s.failedStep)", "['addBankAccount', 'addKycCheck'].includes(s.failedStep)");
    const p = join(d, 'polyflow.workflow.json'); const j = JSON.parse(readFileSync(p, 'utf8'));
    delete j.tools.addAddress; delete j.tools.clearPostalAddresses; delete j.unstoppable.adding_client; delete j.unstoppable.undo_address;
    writeFileSync(p, JSON.stringify(j, null, 2));
  });
  const r3 = await admit(v3, { key });
  assert.ok(r3.ok, `v3 admits on its own (nothing reaches the removed step): ${JSON.stringify(r3.problems)}`);
  const r = vet({ oldDir: v1, newDir: v3, fleet: FLEET, trust });
  assert.equal(r.ok, false);
  // Every run is pinned: the removed actions fail the vocabulary gate for all of
  // them (deprecate, don't delete), and the two parked in the removed step also
  // hold orders the new version cannot complete.
  const gates = Object.fromEntries(r.decisions.map((d) => [d.workflowId, [d.decision, (d.failed ?? []).map((f) => f.gate)]]));
  assert.ok(r.decisions.every((d) => d.decision === 'pin'), JSON.stringify(gates));
  for (const id of ['polyflow/saga/f-2', 'polyflow/saga/f-6']) assert.ok(gates[id][1].includes('open-orders'), `${id}: ${gates[id][1]}`);
  // The gate, given the same versions, refuses to promote.
  const q = 'saga-g';
  const plugin = new PolyflowPlugin({ sink: memorySink(), machines: { saga: v1 }, trust, gate: { client: env.client } });
  const w = await Worker.create({ connection: env.nativeConnection, taskQueue: q, workflowsPath: join(SAMPLE, 'src', 'workflows.mjs'), activities: sample, plugins: [plugin], maxCachedWorkflows: 0, bundlerOptions: { logger: quiet } });
  await w.runUntil(async () => {
    await assert.rejects(
      env.client.workflow.execute('PolyflowGateWorkflow', { taskQueue: q, workflowId: 'saga-gate-g', workflowExecutionTimeout: '2 minutes', args: [{ machine: 'saga', oldDir: v1, newDir: v3, fleet: FLEET, toBuildId: 'v3', fromBuildId: plugin.buildId() }] }),
      (err) => /PolyflowGateRefused|would have to stay on the old version|pin/.test(`${err.message} ${err.cause?.message} ${err.cause?.type}`),
    );
  });
});

test('(h) a run parked on v1 is vetted, told, and continues as new onto v2 when v2 is current; its next order is addKycCheck', async () => {
  const q = 'saga-h';
  const DEPLOYMENT = 'polyflow-saga';
  const v1 = copyMachine(V1); const v2 = copyMachine(V2);
  assert.ok((await admit(v1, { key })).ok); assert.ok((await admit(v2, { key })).ok);
  const gate = { open: false };
  const activities = {
    ...sample,
    // The bank step parks until the test lets it through: the run waits in adding_bank.
    addBankAccount: async (params) => {
      const { Context } = await import('@temporalio/activity');
      while (!gate.open) { Context.current().heartbeat(); await Context.current().sleep(100); }
      return sample.addBankAccount(params);
    },
  };
  const sink = memorySink(); // one record, whichever worker writes it
  const versioned = async (dir) => {
    const plugin = new PolyflowPlugin({ sink, machines: { saga: dir }, trust, gate: { client: env.client } });
    const buildId = plugin.buildId();
    const w = await Worker.create({
      connection: env.nativeConnection, taskQueue: q, workflowsPath: join(SAMPLE, 'src', 'workflows.mjs'), activities, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
      workerDeploymentOptions: { useWorkerVersioning: true, version: { deploymentName: DEPLOYMENT, buildId }, defaultVersioningBehavior: 'PINNED' },
      defaultHeartbeatThrottleInterval: '200ms', maxHeartbeatThrottleInterval: '200ms',
      plugins: [plugin],
    });
    return { worker: w, buildId, running: w.run() };
  };
  const setCurrent = (buildId) => until(async () => {
    await env.client.workflowService.setWorkerDeploymentCurrentVersion({ namespace: 'default', deploymentName: DEPLOYMENT, buildId });
    return true;
  }, `version ${buildId} to become current`, 100);

  const w1 = await versioned(v1);
  const w2 = await versioned(v2);
  assert.notEqual(w1.buildId, w2.buildId, 'two certificates, two build ids');
  try {
    await setCurrent(w1.buildId);
    const { handle, workflowId } = await start(q, COMMAND('saga-h-1'));
    await until(async () => (await handle.query('polyflow.state')).state.phase === 'adding_bank', 'adding_bank');
    const firstRun = handle.firstExecutionRunId;

    // Vet v2 against the live fleet on v1 and tell the runs that move.
    const report = await env.client.workflow.execute('PolyflowGateWorkflow', {
      taskQueue: q, workflowId: 'saga-gate-h', workflowExecutionTimeout: '2 minutes',
      args: [{ machine: 'saga', oldDir: v1, newDir: v2, toBuildId: w2.buildId, fromBuildId: w1.buildId, onVersionChange: true }],
    });
    assert.equal(report.counts.pin ?? 0, 0, JSON.stringify(report));
    assert.equal(report.runs, 1);
    const g = env.client.workflow.getHandle(workflowId);
    assert.equal((await g.describe()).runId, firstRun, 'the run stays on v1 until v2 is current');

    // Promote v2, wake the run: it hands over by state, not by history replay.
    await setCurrent(w2.buildId);
    const woke = await env.client.workflow.execute('PolyflowGateWorkflow', {
      taskQueue: q, workflowId: 'saga-gate-h-wake', workflowExecutionTimeout: '2 minutes', args: [{ machine: 'saga', phase: 'wake' }],
    });
    assert.equal(woke.woken, 1);
    await until(async () => (await g.describe()).runId !== firstRun, 'the hand-over');
    const s = await until(async () => { const x = await g.query('polyflow.state'); return x.orders.length ? x : null; }, 'the carried order');
    assert.equal(s.state.phase, 'adding_bank', 'the state carried over');
    assert.equal(s.certificate.buildId, w2.buildId, 'answered by the v2 machine');
    assert.deepEqual(s.orders.map((o) => o.kind), ['addBankAccount'], 'the parked order was re-issued on v2');

    // Let the bank step through: v2 orders the KYC check next, and opens the account.
    gate.open = true;
    const out = await g.result();
    assert.equal(out.state.phase, 'opened');
    const hist = await g.fetchHistory();
    assert.ok(scheduled(hist).includes('addKycCheck'), `v2's new step ran on a run that started under v1: ${scheduled(hist)}`);
    const first = await env.client.workflow.getHandle(workflowId, firstRun).fetchHistory();
    assert.ok(first.events.some((e) => e.workflowExecutionContinuedAsNewEventAttributes), 'the v1 execution ended in a continue-as-new');
    assert.ok(!scheduled(first).includes('addKycCheck'), 'v1 never ordered the KYC step');
    assert.ok(!hist.events.some((e) => e.workflowExecutionContinuedAsNewEventAttributes), 'and the v2 execution in none: one hand-over');
    // One chain across the hand-over: v1's part closes continued-as-new, v2's part
    // continues it to completion, and nothing is done twice.
    const { events } = sink.read({ ns: 'default', wf: workflowId, run: firstRun });
    assert.ok(verifyChain(events).ok, 'the chain verifies across the hand-over');
    assert.deepEqual(events.filter((e) => e.kind === 'closure').map((e) => e.body.outcome), ['continued-as-new', 'completed']);
    const banks = events.filter((e) => e.kind === 'effect' && e.body.activityType === 'addBankAccount');
    assert.equal(banks.length, 2, 'called off on v1 (carried open), re-issued on v2');
  } finally {
    gate.open = true;
    w1.worker.shutdown(); w2.worker.shutdown();
    await Promise.allSettled([w1.running, w2.running]);
  }
});

test('(i) a step in flight that does not heartbeat finishes where it started: the hand-over waits, the step runs once, the run stays on v1', async () => {
  const q = 'saga-i';
  const DEPLOYMENT = 'polyflow-saga-i';
  const v1 = copyMachine(V1); const v2 = copyMachine(V2);
  assert.ok((await admit(v1, { key })).ok); assert.ok((await admit(v2, { key })).ok);
  const calls = [];
  const activities = {
    ...sample,
    // Three seconds, no heartbeat: a cancellation cannot reach it; it runs to its end.
    addBankAccount: async (params) => { calls.push(Date.now()); await new Promise((r) => setTimeout(r, 3000)); return sample.addBankAccount(params); },
  };
  const sink = memorySink();
  const versioned = async (dir) => {
    const plugin = new PolyflowPlugin({ sink, machines: { saga: dir }, trust, gate: { client: env.client } });
    const buildId = plugin.buildId();
    const w = await Worker.create({
      connection: env.nativeConnection, taskQueue: q, workflowsPath: join(SAMPLE, 'src', 'workflows.mjs'), activities, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
      workerDeploymentOptions: { useWorkerVersioning: true, version: { deploymentName: DEPLOYMENT, buildId }, defaultVersioningBehavior: 'PINNED' },
      defaultHeartbeatThrottleInterval: '200ms', maxHeartbeatThrottleInterval: '200ms',
      plugins: [plugin],
    });
    return { worker: w, buildId, running: w.run() };
  };
  const setCurrent = (buildId) => until(async () => {
    await env.client.workflowService.setWorkerDeploymentCurrentVersion({ namespace: 'default', deploymentName: DEPLOYMENT, buildId });
    return true;
  }, `version ${buildId} to become current`, 100);
  const w1 = await versioned(v1);
  const w2 = await versioned(v2);
  try {
    await setCurrent(w1.buildId);
    const { handle, workflowId } = await start(q, COMMAND('saga-i-1'));
    await until(async () => (await handle.query('polyflow.state')).state.phase === 'adding_bank', 'adding_bank');
    const firstRun = handle.firstExecutionRunId;
    const report = await env.client.workflow.execute('PolyflowGateWorkflow', {
      taskQueue: q, workflowId: 'saga-gate-i', workflowExecutionTimeout: '2 minutes',
      args: [{ machine: 'saga', oldDir: v1, newDir: v2, toBuildId: w2.buildId, fromBuildId: w1.buildId, onVersionChange: true }],
    });
    assert.equal(report.runs, 1);
    await setCurrent(w2.buildId);
    await env.client.workflow.execute('PolyflowGateWorkflow', { taskQueue: q, workflowId: 'saga-gate-i-wake', workflowExecutionTimeout: '2 minutes', args: [{ machine: 'saga', phase: 'wake' }] });
    const g = env.client.workflow.getHandle(workflowId);
    const out = await g.result();
    // The bank step ran once, its completion was stepped on v1, and the run
    // (no longer in the state the gate vetted) stayed there: opened, no KYC.
    assert.equal(calls.length, 1, `addBankAccount invoked ${calls.length} time(s)`);
    assert.equal(out.state.phase, 'opened');
    assert.equal((await g.describe()).runId, firstRun, 'no hand-over: the run moved on');
    const journal = await g.query('polyflow.journal');
    assert.ok(journal.some((j) => j.stepKind === 'migration-stale'), 'the stale migration is on the record');
    assert.ok(!scheduled(await g.fetchHistory()).includes('addKycCheck'));
    const { events } = sink.read({ ns: 'default', wf: workflowId, run: firstRun });
    assert.ok(verifyChain(events).ok);
    assert.equal(events.filter((e) => e.kind === 'effect' && e.body.activityType === 'addBankAccount').length, 1);
  } finally {
    w1.worker.shutdown(); w2.worker.shutdown();
    await Promise.allSettled([w1.running, w2.running]);
  }
});

test('(j) a person CANCELs the saga past its first steps: what succeeded is compensated, last first', async () => {
  const gate = { open: false };
  const w = await worker('saga-j', {
    ...sample,
    addBankAccount: async (params) => {
      const { Context } = await import('@temporalio/activity');
      while (!gate.open) { Context.current().heartbeat(); await Context.current().sleep(100); }
      return sample.addBankAccount(params);
    },
  });
  const out = await w.runUntil(async () => {
    const { handle } = await start('saga-j', COMMAND('saga-j-1'));
    await until(async () => (await handle.query('polyflow.state')).state.phase === 'adding_bank', 'adding_bank');
    // STOP is refused here: a step succeeded that a stop would leave standing.
    const stop = await handle.executeUpdate('polyflow.propose', { args: [{ action: 'STOP', actor: { id: 'ops', roles: ['human'] } }] }).then(() => null, (e) => `${e.message} ${e.cause?.message ?? ''}`);
    assert.match(stop, /nothing-to-stop/);
    const r = await handle.executeUpdate('polyflow.propose', { args: [{ action: 'CANCEL', actor: { id: 'ops', roles: ['human'] } }] });
    assert.equal(r.stepKind, 'accepted');
    return handle.result();
  });
  gate.open = true;
  assert.deepEqual([out.state.phase, out.state.failedStep, out.state.reason], ['compensated', 'addBankAccount', 'cancelled']);
  assert.deepEqual(await steps('polyflow/saga/saga-j-1'), ['createAccount', 'addAddress', 'addClient', 'addBankAccount', 'removeClient', 'clearPostalAddresses']);
});
