// The polyflow/polycrew seam, proved while there is still only one package.
//
// polycrew supplies two of polyflow's four exports: a broker (its own is
// store-backed and shared across processes) and extra tools. If a substitute
// broker can drive a real run end to end, and extra tools reach the surface,
// the split holds — and if it does not, we find out here rather than after
// polycrew exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Through the public entry, not the internals — this is the import polycrew makes.
import { Polyflow, makeTools, Library, Broker, serve, Area, deriveKey } from '../src/index.mjs';

const WORKFLOWS = resolve(import.meta.dirname, '..', 'workflows');

/**
 * A broker that satisfies the contract without polyflow's parked-promise
 * machinery: it settles orders through an explicit queue the test drives.
 * Deliberately not a subclass — it shares no code with the real one.
 */
class RecordingBroker {
  constructor({ heartbeatMs = 20 } = {}) {
    this.calls = [];
    this.all = new Map();
    this.waiting = new Map();
    this.heartbeatMs = heartbeatMs;
    this.renewals = 0;
  }

  handler(kind, spec = {}) {
    return (payload, intentId, ctx) => new Promise((resolve, reject) => {
      const order = {
        orderId: intentId, instanceId: ctx.instanceId, kind,
        tool: spec.tool ?? kind, target: spec.target ?? null, args: payload ?? {},
        why: spec.why ?? '', attempt: ctx.attempt, status: 'open',
      };
      this.all.set(intentId, order);
      // Contract obligation 1: an order parks for as long as the agent takes,
      // so the worker lease has to be kept alive or polyrun re-offers the order
      // to someone else while the first actor is still working it.
      const timer = setInterval(() => {
        this.renewals += 1;
        ctx.extendLease(this.heartbeatMs * 2).catch(() => {});
      }, this.heartbeatMs);
      timer.unref?.();
      this.waiting.set(intentId, { resolve, reject, timer });
      this.calls.push(['handler', kind]);
    });
  }

  open(instanceId) {
    return [...this.all.values()].filter((o) => o.status === 'open' && o.instanceId === instanceId);
  }

  orderById(orderId) { return this.all.get(orderId); }

  issued(instanceId) {
    return [...this.all.values()].filter((o) => o.instanceId === instanceId);
  }

  report(orderId, { ok = true, result = {}, error = '', permanent = false } = {}) {
    const w = this.waiting.get(orderId);
    if (!this.all.has(orderId)) return { ok: false, reason: 'unknown-order' };
    if (!w) return { ok: false, reason: 'order-expired' };
    clearInterval(w.timer);
    this.waiting.delete(orderId);
    this.all.get(orderId).status = ok ? 'done' : 'failed';
    this.calls.push(['report', orderId.slice(0, 6), ok]);
    // Contract obligation 3: the resolved value becomes the completion
    // action's data, and a bare string has no fields for the machine to read.
    if (ok) w.resolve(result && typeof result === 'object' ? result : { value: result });
    else w.reject(Object.assign(new Error(error || 'failed'), { permanent }));
    return { ok: true };
  }

  abort(reason = 'shutting down') {
    for (const [, w] of this.waiting) { clearInterval(w.timer); w.reject(new Error(reason)); }
    this.waiting.clear();
  }
}

test('the public surface is exactly what the boundary promises', () => {
  for (const [name, thing] of Object.entries({ Polyflow, makeTools, Library, Broker, serve, Area, deriveKey })) {
    assert.equal(typeof thing, 'function', `${name} must be exported from src/index.mjs`);
  }
});

test('a substitute broker drives a real run end to end', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-seam-'));
  const broker = new RecordingBroker();
  const pf = new Polyflow({
    workflowsDir: WORKFLOWS, dbPath: join(dir, 'seam.sqlite'),
    agent: 'polycrew', instance: 'acme', pollMs: 20, broker,
  });
  await pf.start();
  t.after(async () => {
    await pf.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const tools = makeTools(pf);
  const call = (n, a) => tools.find((x) => x.name === n).handler(a);

  let v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-08-26' } });
  assert.equal(v.next[0].tool, 'github_search_issues');

  v = await call('workflow_report', { order_id: v.next[0].order_id, result: { count: 3 } });
  assert.equal(v.state.briefState, 'drafting');
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: {} });
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: {} });
  assert.equal(v.state.briefState, 'posting');
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: {} });
  assert.equal(v.state.briefState, 'posted');
  assert.equal(v.done, true);

  // The engine never reached past the contract into the broker's internals.
  assert.equal(broker.calls.filter(([k]) => k === 'handler').length, 4);
  assert.equal(broker.issued(v.instance).length, 4);
  assert.equal(broker.open(v.instance).length, 0);
});

test('extra tools reach the surface, and a name collision is refused', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-seam2-'));
  const pf = new Polyflow({
    workflowsDir: WORKFLOWS, dbPath: join(dir, 'seam2.sqlite'),
    agent: 'polycrew', instance: 'acme', pollMs: 20, broker: new RecordingBroker(),
  });
  await pf.start();
  t.after(async () => {
    await pf.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const crewTool = {
    name: 'workflow_claim',
    description: 'Claim an open work order so no other actor takes it. Placeholder for polycrew.',
    inputSchema: { type: 'object', required: ['order_id'], properties: { order_id: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { claimed: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async () => ({ claimed: true }),
  };

  const tools = makeTools(pf, [crewTool]);
  assert.equal(tools.length, 7);
  assert.ok(tools.some((t2) => t2.name === 'workflow_claim'));
  assert.deepEqual(await tools.find((t2) => t2.name === 'workflow_claim').handler({}), { claimed: true });

  assert.throws(
    () => makeTools(pf, [{ name: 'workflow_report', handler: async () => ({}) }]),
    /collides with a built-in/,
    'a layer above must not silently replace a built-in tool'
  );
});

// -- the obligations a substitute broker can pass every fast test by ignoring --

test('a parked order keeps its worker lease alive', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-lease-'));
  const broker = new RecordingBroker({ heartbeatMs: 20 });
  const pf = new Polyflow({
    workflowsDir: WORKFLOWS, dbPath: join(dir, 'lease.sqlite'),
    agent: 'polycrew', instance: 'acme', pollMs: 20, broker,
  });
  await pf.start();
  t.after(async () => {
    await pf.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const tools = makeTools(pf);
  const v = await tools.find((x) => x.name === 'workflow_start')
    .handler({ workflow: 'customer-brief', input: { date: '2026-08-27' } });

  // Hold it the way an agent does — across turns, not milliseconds.
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(broker.renewals > 0,
    'a handler that never extends its lease lets polyrun re-offer the order to a second actor');
  assert.equal(broker.open(v.instance).length, 1, 'and the order is still the first actor’s');
});

test('orderById carries the run, because a report has nothing else to go on', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-oid-'));
  const broker = new RecordingBroker();
  const pf = new Polyflow({
    workflowsDir: WORKFLOWS, dbPath: join(dir, 'oid.sqlite'),
    agent: 'polycrew', instance: 'acme', pollMs: 20, broker,
  });
  await pf.start();
  t.after(async () => {
    await pf.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const tools = makeTools(pf);
  const v = await tools.find((x) => x.name === 'workflow_start')
    .handler({ workflow: 'customer-brief', input: { date: '2026-08-28' } });

  const order = broker.orderById(v.next[0].order_id);
  assert.equal(order.instanceId, v.instance,
    'workflow_report resolves an order id to its run through this field alone');
  // open() drops it on purpose: that caller already knows the run.
  assert.equal(broker.open(v.instance)[0].instanceId, order.instanceId,
    'this substitute keeps it; the contract only requires orderById to');
});

test('one broker, one owner', () => {
  const broker = new Broker();
  const make = () => new Polyflow({ workflowsDir: WORKFLOWS, dbPath: ':memory:', broker });
  make();
  assert.throws(make, /already belongs to another Polyflow/,
    'abort() fails every parked handler, so a shared broker means either daemon can fail the other’s orders');
});

test('two extra tools colliding blame each other, not a built-in', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-extra-'));
  const pf = new Polyflow({
    workflowsDir: WORKFLOWS, dbPath: join(dir, 'extra.sqlite'),
    agent: 'polycrew', instance: 'acme', pollMs: 20, broker: new RecordingBroker(),
  });
  await pf.start();
  t.after(async () => {
    await pf.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const twice = [{ name: 'workflow_claim' }, { name: 'workflow_claim' }];
  assert.throws(() => makeTools(pf, twice), /collides with another extra tool/,
    'blaming a built-in sends the reader hunting for one that is not there');
});
