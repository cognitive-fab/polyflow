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

import { Polyflow } from '../src/daemon.mjs';
import { makeTools } from '../src/tools.mjs';

const WORKFLOWS = resolve(import.meta.dirname, '..', 'workflows');

/**
 * A broker that satisfies the contract without polyflow's parked-promise
 * machinery: it settles orders through an explicit queue the test drives.
 * Deliberately not a subclass — it shares no code with the real one.
 */
class RecordingBroker {
  constructor() {
    this.calls = [];
    this.all = new Map();
    this.waiting = new Map();
  }

  handler(kind, spec = {}) {
    return (payload, intentId, ctx) => new Promise((resolve, reject) => {
      const order = {
        orderId: intentId, instanceId: ctx.instanceId, kind,
        tool: spec.tool ?? kind, target: spec.target ?? null, args: payload ?? {},
        why: spec.why ?? '', attempt: ctx.attempt, status: 'open',
      };
      this.all.set(intentId, order);
      this.waiting.set(intentId, { resolve, reject });
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
    this.waiting.delete(orderId);
    this.all.get(orderId).status = ok ? 'done' : 'failed';
    this.calls.push(['report', orderId.slice(0, 6), ok]);
    if (ok) w.resolve(result);
    else w.reject(Object.assign(new Error(error || 'failed'), { permanent }));
    return { ok: true };
  }

  abort(reason = 'shutting down') {
    for (const [, w] of this.waiting) w.reject(new Error(reason));
    this.waiting.clear();
  }
}

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
