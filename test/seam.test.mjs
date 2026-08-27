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
    this.reporters = [];
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

  report(orderId, { ok = true, result = {}, error = '', permanent = false, actor } = {}) {
    this.reporters.push(actor ?? null);
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

test('the reporting actor rides beside the arguments, never inside them', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-actor-'));
  const broker = new RecordingBroker();
  const pf = new Polyflow({
    workflowsDir: WORKFLOWS, dbPath: join(dir, 'actor.sqlite'),
    agent: 'polycrew', instance: 'acme', pollMs: 20, broker,
  });
  await pf.start();
  t.after(async () => {
    await pf.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const tools = makeTools(pf);
  const report = tools.find((x) => x.name === 'workflow_report');

  // No schema field names the reporter — a model that could name it could
  // report as someone else, which is the derived-key finding one level up.
  assert.ok(!Object.keys(report.inputSchema.properties).includes('actor'));

  let v = await tools.find((x) => x.name === 'workflow_start')
    .handler({ workflow: 'customer-brief', input: { date: '2026-08-29' } });

  // A host that knows who is calling passes it as the second argument.
  v = await report.handler({ order_id: v.next[0].order_id, result: { count: 1 } }, 'claude-code/aaaa');
  assert.deepEqual(broker.reporters, ['claude-code/aaaa'], 'the broker can enforce a claim with this');

  // And the single-agent path still reports with nobody named.
  await report.handler({ order_id: v.next[0].order_id, result: {} });
  assert.deepEqual(broker.reporters, ['claude-code/aaaa', null]);
});

test('runs() lists this area and no other, and timers() what it waits on', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-runs-'));
  const pf = new Polyflow({
    workflowsDir: WORKFLOWS, dbPath: join(dir, 'runs.sqlite'),
    agent: 'polycrew', instance: 'acme', pollMs: 20, broker: new RecordingBroker(),
  });
  await pf.start();
  t.after(async () => {
    await pf.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const tools = makeTools(pf);
  const call = (n, a) => tools.find((x) => x.name === n).handler(a);

  await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-12-02' } });
  let v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-12-01' } });

  // What a second project sharing this file leaves behind: a real instance row
  // in another area. Written directly rather than by a second daemon, because
  // two runtimes on one store poll the same outbox and claim each other's
  // effects — the configuration a crew avoids by electing ONE broker, so it is
  // not one polyflow should be tested in.
  await pf.rt.store.insertInstance({
    instanceId: 'polycrew|other|customer-brief|2026-12-03',
    machineId: 'customer-brief',
    machineVersion: 'whatever',
    state: { briefState: 'gathering', ticketCount: 0, reason: '' },
    now: Date.now(),
  });

  const runs = await pf.runs({ status: 'active' });
  assert.deepEqual(runs.map((r) => r.key).sort(), ['2026-12-01', '2026-12-02'],
    'another area shares the file, not the view');
  for (const r of runs) {
    assert.equal(r.workflow, 'customer-brief');
    assert.equal(r.done, false);
    assert.ok(r.instanceId.startsWith('polycrew|acme|'));
  }

  // Drive one into review, where the workflow arms its approval window.
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: { count: 1 } });
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: {} });
  assert.equal(v.state.briefState, 'review');

  const timers = await pf.timers(v.instance);
  assert.equal(timers.length, 1, 'the run is waiting on something a person can be shown');
  assert.equal(timers[0].action, 'DENIED');
  assert.ok(timers[0].fireAt > Date.now(), 'and when it runs out');
  assert.deepEqual(await pf.timers('polycrew|acme|customer-brief|2026-12-02'), []);
});

test('a broker whose report answers asynchronously still gets a view', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-async-'));
  const broker = new RecordingBroker();
  const inner = broker.report.bind(broker);
  // Nothing in the contract makes report synchronous, so a substitute may
  // answer with a promise. Reading .ok off it would report every failure as a
  // success and answer {} to every call.
  broker.report = (...args) => Promise.resolve(inner(...args));

  const pf = new Polyflow({
    workflowsDir: WORKFLOWS, dbPath: join(dir, 'async.sqlite'),
    agent: 'polycrew', instance: 'acme', pollMs: 20, broker,
  });
  await pf.start();
  t.after(async () => {
    await pf.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const tools = makeTools(pf);
  const call = (n, a) => tools.find((x) => x.name === n).handler(a);
  let v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2027-02-01' } });
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: { count: 4 } });
  assert.equal(v.state.briefState, 'drafting', 'the run moved and the caller was told');
  assert.equal(v.error, undefined);

  // And a refusal still reads as a refusal rather than as an empty object.
  const bad = await call('workflow_report', { order_id: 'no-such-order', result: {} });
  assert.match(bad.error, /unknown order/);
});

test('reading a run never repairs it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-pureread-'));
  const broker = new RecordingBroker();
  const asked = [];
  const inner = broker.open.bind(broker);
  broker.open = (id, opts) => { asked.push(opts); return inner(id, opts); };

  const pf = new Polyflow({
    workflowsDir: WORKFLOWS, dbPath: join(dir, 'pure.sqlite'),
    agent: 'polycrew', instance: 'acme', pollMs: 20, broker,
  });
  await pf.start();
  t.after(async () => {
    await pf.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const tools = makeTools(pf);
  const v = await tools.find((x) => x.name === 'workflow_start')
    .handler({ workflow: 'customer-brief', input: { date: '2027-02-02' } });
  await tools.find((x) => x.name === 'workflow_state').handler({ instance: v.instance });

  assert.ok(asked.length > 0);
  for (const opts of asked) {
    assert.deepEqual(opts, { sweep: false },
      'workflow_state says readOnlyHint; a broker sweeping here would make it a writer');
  }
});

test('a closed Polyflow lets go of its broker', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-reuse-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ } });
  const broker = new Broker();
  const make = () => new Polyflow({
    workflowsDir: WORKFLOWS, dbPath: join(dir, 'reuse.sqlite'), pollMs: 20, broker,
  });

  // Never started, so nothing was ever owned in practice.
  const stillborn = make();
  await stillborn.close();
  const first = make();
  await first.start();
  await first.close();

  // A re-election in one process hands the same broker to a replacement.
  const second = make();
  await second.start();
  t.after(() => second.close());
  assert.equal(second.certificates.size > 0, true, 'the replacement really started');
});

test('a run in flight is still shown when its workflow stops being admitted', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-degraded-'));
  const pf = new Polyflow({
    workflowsDir: WORKFLOWS, dbPath: join(dir, 'deg.sqlite'),
    agent: 'polycrew', instance: 'acme', pollMs: 20, broker: new RecordingBroker(),
  });
  await pf.start();
  t.after(async () => {
    await pf.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  await makeTools(pf).find((x) => x.name === 'workflow_start')
    .handler({ workflow: 'customer-brief', input: { date: '2027-02-03' } });
  assert.equal((await pf.runs({ status: 'active' }))[0].admitted, true);

  // The library was edited and no longer passes the gate. The run is still in
  // flight with an open order waiting on someone; hiding it is the opposite of
  // what a "what needs a person" view is for.
  pf.admitted = () => false;
  const runs = await pf.runs({ status: 'active' });
  assert.equal(runs.length, 1, 'a degraded library must not empty the dashboard');
  assert.equal(runs[0].admitted, false, 'and the page can say so');
});
