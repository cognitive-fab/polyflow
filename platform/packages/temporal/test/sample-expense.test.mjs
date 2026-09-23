// P11 sample 2 — Temporal's `expense` sample (samples-typescript, pinned under
// examples/upstream) as a certified machine at G2, admitted at G3. The sample's
// activities.ts is byte for byte upstream's; its control flow is the machine in
// examples/temporal_samples/expense/machine; the Express server is the sample's.
//
// (a) admission passes and the certificate names the three guarantees;
// (b) a mutation that pays without an approval is REFUSED by admission, by name;
// (c) approve → payment scheduled once, the server shows COMPLETED;
// (d) reject → no payment; the window closing → no payment;
// (e) an approval from an actor without the human role, or naming no order, is refused;
// (f) a completion proposed by hand for an order this worker performs is refused;
// (g) a second start for the same expense attaches instead of paying twice;
// (h) STOP while the request is out ends the run, the request called off, nothing paid;
// (i) a worker with a trust store refuses the machine when one byte of it differs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from '@temporalio/worker';
import { admit } from '@cognitive-fab/polyflow-cli/src/admit.mjs';
import { PolyflowPlugin, memorySink, startGoverned, loadMachineDir, generateSigningKey } from '../src/index.mjs';
import { startEnv, scheduled, quiet } from './helpers.mjs';

const SAMPLE = fileURLToPath(new URL('../../../examples/temporal_samples/expense/', import.meta.url));
const MACHINE = join(SAMPLE, 'machine');
const { descriptor } = loadMachineDir(MACHINE);
const { startServer } = await import(new URL('src/server.mjs', `file:///${SAMPLE.replace(/\\/g, '/')}`).href);
const orders = await import(new URL('src/orders.mjs', `file:///${SAMPLE.replace(/\\/g, '/')}`).href);

let env, server;
const made = [];
before(async () => {
  env = await startEnv();
  server = await startServer(3000); // the sample's activities POST to localhost:3000
});
after(async () => {
  await env?.teardown();
  await server?.close();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const key = generateSigningKey('expense-ci');
const trust = { [key.keyId]: key.publicKeyPem };
const human = { id: 'manager', roles: ['human'] };

async function worker(taskQueue, plugin = new PolyflowPlugin({ sink: memorySink(), machines: { expense: MACHINE }, allowUncertified: true })) {
  return Worker.create({
    connection: env.nativeConnection, taskQueue, workflowsPath: join(SAMPLE, 'src', 'workflows.mjs'), activities: orders, plugins: [plugin],
    maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
  });
}
const start = (taskQueue, expenseId) => startGoverned(env.client, { descriptor, input: { expenseId }, taskQueue, workflowExecutionTimeout: '60s' });
const until = async (fn, what, n = 200) => {
  for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}`);
};
const approvalOrder = (h) => until(async () => (await h.query('polyflow.state')).orders.find((o) => o.kind === 'request_approval'), 'the approval request');
const msg = (e) => `${e?.message} ${e?.cause?.message ?? ''}`;

function copyMachine(mutate) {
  const dir = mkdtempSync(join(fileURLToPath(new URL('../../../examples/', import.meta.url)), '.tmp-expense-'));
  made.push(dir);
  cpSync(MACHINE, dir, { recursive: true });
  rmSync(join(dir, 'polyflow.certificate.json'), { force: true });
  if (mutate) mutate(dir);
  return dir;
}

test('(a) admission certifies the machine and names the guarantees', async () => {
  const r = await admit(copyMachine(), { key });
  assert.ok(r.ok, JSON.stringify(r.problems));
  for (const g of ['no-payment-without-prior-approve', 'at-most-one-payment-per-path', 'no-payment-after-reject-or-timeout']) {
    assert.ok(r.certificate.guarantees.includes(g), g);
  }
});

test('(b) a machine that pays without asking is refused by admission, by name', async () => {
  const dir = copyMachine((d) => {
    const p = join(d, 'machine.cjs');
    // CREATED goes straight to paying: the approval step is skipped.
    writeFileSync(p, readFileSync(p, 'utf8').replace("next.expenseState = 'pending_approval';", "next.expenseState = 'paying';"));
  });
  const r = await admit(dir, { key });
  assert.equal(r.ok, false);
  const text = JSON.stringify(r.problems);
  assert.match(text, /no-payment-without-prior-approve/);
  assert.match(text, /payment-implies-approval-was-requested/);
});

test('(c) approved: the sample\'s activities run, payment once, the server says COMPLETED', async () => {
  const w = await worker('exp-c');
  const out = await w.runUntil(async () => {
    const { handle, workflowId } = await start('exp-c', 'exp-c-1');
    assert.equal(workflowId, 'polyflow/expense/exp-c-1');
    const order = await approvalOrder(handle);
    assert.equal(order.role, 'human');
    assert.equal(server.expenses.get('exp-c-1'), 'CREATED');
    const r = await handle.executeUpdate('polyflow.propose', { args: [{ action: 'APPROVE', orderId: order.orderId, actor: human }] });
    assert.equal(r.stepKind, 'accepted');
    return handle.result();
  });
  assert.equal(out.state.expenseState, 'completed');
  assert.equal(server.expenses.get('exp-c-1'), 'COMPLETED');
  const history = await env.client.workflow.getHandle('polyflow/expense/exp-c-1').fetchHistory();
  assert.deepEqual(scheduled(history).filter((t) => !t.startsWith('polyflow.')), ['createExpense', 'request_approval', 'payment']);
});

test('(d) rejected, or nobody answers: the run ends and nothing is paid', async () => {
  const w = await worker('exp-d');
  await w.runUntil(async () => {
    const { handle } = await start('exp-d', 'exp-d-reject');
    const order = await approvalOrder(handle);
    await handle.executeUpdate('polyflow.propose', { args: [{ action: 'REJECT', data: { reason: 'rejected' }, orderId: order.orderId, actor: human }] });
    const out = await handle.result();
    assert.deepEqual(out.state, { expenseState: 'rejected', expenseId: 'exp-d-reject', reason: 'rejected' });
    // The window is 10 s in the certified machine (upstream's default).
    const t = await start('exp-d', 'exp-d-timeout');
    const late = await t.handle.result();
    assert.deepEqual(late.state, { expenseState: 'timed_out', expenseId: 'exp-d-timeout', reason: 'timed-out' });
  });
  for (const id of ['exp-d-reject', 'exp-d-timeout']) {
    const history = await env.client.workflow.getHandle(`polyflow/expense/${id}`).fetchHistory();
    assert.ok(!scheduled(history).includes('payment'), `${id}: no payment`);
    assert.equal(server.expenses.get(id), 'CREATED');
  }
});

test('(e) an approval needs the human role and the open order; anything else is refused', async () => {
  const w = await worker('exp-e');
  await w.runUntil(async () => {
    const { handle } = await start('exp-e', 'exp-e-1');
    const order = await approvalOrder(handle);
    const noRole = await handle.executeUpdate('polyflow.propose', { args: [{ action: 'APPROVE', orderId: order.orderId, actor: { id: 'mallory' } }] }).then(() => null, msg);
    assert.match(noRole, /addressed to role 'human'/);
    const bare = await handle.executeUpdate('polyflow.propose', { args: [{ action: 'APPROVE', actor: human }] }).then(() => null, msg);
    assert.match(bare, /report it against the order/);
    const s = await handle.query('polyflow.state');
    assert.equal(s.state.expenseState, 'pending_approval');
    await handle.executeUpdate('polyflow.propose', { args: [{ action: 'STOP', actor: human }] });
    await handle.result();
  });
});

test('(f) a completion proposed by hand for an order this worker performs is refused', async () => {
  // The server is down for this run: createExpense retries, so its order stays open.
  const port = await server.close().then(() => 3000);
  const w = await worker('exp-f');
  try {
    await w.runUntil(async () => {
      const { handle } = await start('exp-f', 'exp-f-1');
      const order = await until(async () => (await handle.query('polyflow.state')).orders.find((o) => o.kind === 'createExpense'), 'the create order');
      const r = await handle.executeUpdate('polyflow.propose', { args: [{ action: 'CREATED', orderId: order.orderId, actor: human }] }).then(() => null, msg);
      assert.match(r, /performed by this worker/);
      await handle.executeUpdate('polyflow.propose', { args: [{ action: 'STOP', actor: human }] });
      await handle.result();
    });
  } finally {
    server = await startServer(port);
  }
});

test('(g) a second start for the same expense attaches to the first run', async () => {
  const w = await worker('exp-g');
  await w.runUntil(async () => {
    const a = await start('exp-g', 'exp-g-1');
    const b = await start('exp-g', 'exp-g-1');
    assert.equal(b.status, 'attached');
    assert.equal(b.workflowId, a.workflowId);
    const order = await approvalOrder(a.handle);
    await a.handle.executeUpdate('polyflow.propose', { args: [{ action: 'APPROVE', orderId: order.orderId, actor: human }] });
    await a.handle.result();
    const c = await start('exp-g', 'exp-g-1');
    assert.equal(c.status, 'complete');
  });
  const history = await env.client.workflow.getHandle('polyflow/expense/exp-g-1').fetchHistory();
  assert.equal(scheduled(history).filter((t) => t === 'payment').length, 1);
});

test('(h) STOP while the request is out: the request is called off, nothing is paid', async () => {
  const w = await worker('exp-h');
  const out = await w.runUntil(async () => {
    const { handle } = await start('exp-h', 'exp-h-1');
    await approvalOrder(handle);
    await handle.executeUpdate('polyflow.propose', { args: [{ action: 'STOP', actor: human }] });
    return handle.result();
  });
  assert.equal(out.state.expenseState, 'stopped');
  const history = await env.client.workflow.getHandle('polyflow/expense/exp-h-1').fetchHistory();
  assert.ok(!scheduled(history).includes('payment'));
  assert.ok(history.events.some((e) => e.activityTaskCancelRequestedEventAttributes), 'the parked request was called off');
});

test('(i) a worker with a trust store refuses a machine whose bytes differ from its certificate', async () => {
  const dir = copyMachine();
  const r = await admit(dir, { key });
  assert.ok(r.ok);
  assert.doesNotThrow(() => new PolyflowPlugin({ sink: memorySink(), machines: { expense: dir }, trust }));
  const p = join(dir, 'effects.cjs');
  writeFileSync(p, readFileSync(p, 'utf8').replace('10 * 1000', '10 * 1001'));
  assert.throws(() => new PolyflowPlugin({ sink: memorySink(), machines: { expense: dir }, trust }), /not the ones admitted/);
});
