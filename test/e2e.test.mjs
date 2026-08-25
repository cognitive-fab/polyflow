// End-to-end: an agent driving a certified workflow through the tool surface.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Polyflow } from '../src/daemon.mjs';
import { makeTools } from '../src/tools.mjs';

const WORKFLOWS = resolve(import.meta.dirname, '..', 'workflows');
let dir, pf, tools;
const call = (name, args = {}) => tools.find((t) => t.name === name).handler(args);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'polyflow-'));
  pf = new Polyflow({
    workflowsDir: WORKFLOWS,
    dbPath: join(dir, 'test.sqlite'),
    agent: 'openworker/cowork',
    instance: 'acme',
    pollMs: 20,
  });
  await pf.start();
  tools = makeTools(pf);
});

after(async () => {
  await pf?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the admission gate certifies the demo workflow exhaustively', () => {
  const cert = pf.certificates.get('customer-brief');
  assert.equal(cert.ok, true);
  assert.equal(cert.bounded, false, 'a bounded run is not a pass');
  assert.ok(cert.pathsExplored > 0);
  assert.ok(cert.invariantNames.includes('no-post-without-prior-approval'));
});

test('workflow_list reports the guarantees the run was admitted under', async () => {
  const { workflows } = await call('workflow_list');
  const wf = workflows.find((w) => w.name === 'customer-brief');
  assert.equal(wf.admitted, true);
  assert.ok(wf.guarantees.includes('at-most-one-post-per-path'));
});

test('happy path: one order at a time, ending posted', async () => {
  let v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-08-25' } });
  assert.equal(v.next.length, 1);
  assert.equal(v.next[0].tool, 'github_search_issues');
  assert.equal(v.state.briefState, 'gathering');

  v = await call('workflow_report', { order_id: v.next[0].order_id, result: { count: 3 } });
  assert.equal(v.state.briefState, 'drafting');
  assert.equal(v.next[0].tool, 'ask');
  assert.equal(v.next[0].args.ticketCount, 3);

  v = await call('workflow_report', { order_id: v.next[0].order_id, result: {} });
  assert.equal(v.state.briefState, 'review');
  assert.equal(v.next[0].tool, 'ask_user');

  v = await call('workflow_report', { order_id: v.next[0].order_id, result: {} });
  assert.equal(v.state.briefState, 'posting');
  assert.equal(v.next[0].tool, 'slack_send');
  assert.equal(v.next[0].target, '#cs');

  v = await call('workflow_report', { order_id: v.next[0].order_id, result: {} });
  assert.equal(v.state.briefState, 'posted');
  assert.equal(v.done, true);
  assert.equal(v.next.length, 0);
});

test('the run key is derived from input, not chosen by the caller', async () => {
  // An agent that finds a finished run must not be able to rename its way to a
  // second one (FINDINGS-phase3.md §6).
  const a = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-02-01' } });
  assert.equal(a.key, '2026-02-01');

  const renamed = await call('workflow_start', {
    workflow: 'customer-brief', key: '2026-02-01-r2', input: { date: '2026-02-01' },
  });
  assert.equal(renamed.instance, a.instance, 'a supplied key must not create a second run');
  assert.match(renamed.key_note, /ignored/);
});

test('an invalid key field is refused with an instruction, not honoured', async () => {
  const bad = await call('workflow_start', {
    workflow: 'customer-brief', input: { date: '2026-02-01-r2' },
  }).catch((err) => err);
  assert.ok(bad instanceof Error);
  assert.match(bad.message, /input\.date = "2026-02-01-r2" does not match/);
  assert.match(bad.message, /YYYY-MM-DD/);
  assert.match(bad.message, /a second key would run the job again/);
});

test('a finished run says so, and says not to start another', async () => {
  let v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-02-02' } });
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: { count: 0 } });
  assert.equal(v.done, true);

  const again = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-02-02' } });
  assert.equal(again.already_complete, true);
  assert.match(again.note, /Do NOT start another run/);
});

test('start is idempotent: re-attaching returns the run in progress', async () => {
  const a = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-01-02' } });
  assert.equal(a.state.briefState, 'gathering');
  const orderId = a.next[0].order_id;

  const b = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-01-02' } });
  assert.equal(b.instance, a.instance, 'same key must not start a second run');
  assert.equal(b.state.briefState, 'gathering');
  assert.equal(b.next[0].order_id, orderId, 'the open order is re-offered, not duplicated');
});

test('a denial is a result, not a fault — and no post is ever ordered', async () => {
  let v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-01-03' } });
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: { count: 3 } });
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: {} });
  assert.equal(v.next[0].tool, 'ask_user');

  v = await call('workflow_report', {
    order_id: v.next[0].order_id, ok: false, permanent: true, error: 'not-ready',
  });
  assert.equal(v.state.briefState, 'denied');
  assert.equal(v.done, true);

  const { journal } = await call('workflow_journal', { instance: v.instance });
  assert.ok(!journal.some((r) => r.action === 'POST_DONE'));
  const ordered = [...pf.broker.orders.values()].filter((o) => o.instanceId === v.instance);
  assert.ok(!ordered.some((o) => o.kind === 'post_brief'), 'no post order may exist on a denied run');
});

test('zero tickets ends the run rather than posting an empty brief', async () => {
  let v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-01-04' } });
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: { count: 0 } });
  assert.equal(v.state.briefState, 'denied');
  assert.equal(v.state.reason, 'no-empty-brief');
  assert.equal(v.done, true);
});

test('a duplicate report is refused, not double-executed', async () => {
  let v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-01-05' } });
  const orderId = v.next[0].order_id;
  v = await call('workflow_report', { order_id: orderId, result: { count: 3 } });
  assert.equal(v.state.briefState, 'drafting');

  const again = await call('workflow_report', { order_id: orderId, result: { count: 99 } });
  assert.equal(again.error, 'order-expired');
  const state = await call('workflow_state', { instance: v.instance });
  assert.equal(state.state.ticketCount, 3, 'the duplicate must not have changed anything');
});

test('an out-of-band action that does not apply is an observable reject', async () => {
  const v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-01-06' } });
  const signalled = await call('workflow_signal', { instance: v.instance, action: 'POST_DONE' });
  assert.equal(signalled.state.briefState, 'gathering', 'state is unchanged');

  const { journal } = await call('workflow_journal', { instance: v.instance });
  const rejected = journal.find((r) => r.action === 'POST_DONE');
  assert.equal(rejected.step_kind, 'rejected');
  assert.equal(rejected.reason, 'stale-completion');
});
