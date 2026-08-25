// The gate has to bite, and the run has to outlive the process. Those are the
// two claims polyflow makes that a prose instruction string cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Polyflow } from '../src/daemon.mjs';
import { makeTools } from '../src/tools.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('a workflow that can post before approval is REFUSED and cannot be started', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-gate-'));
  const lib = join(dir, 'workflows');
  mkdirSync(lib, { recursive: true });
  cpSync(join(ROOT, 'test', 'fixtures', 'unsafe-brief'), join(lib, 'unsafe-brief'), { recursive: true });

  const pf = new Polyflow({ workflowsDir: lib, dbPath: join(dir, 'gate.sqlite'), pollMs: 20 });
  await pf.start();
  t.after(async () => { await pf.close(); rmSync(dir, { recursive: true, force: true }); });

  const cert = pf.certificates.get('unsafe-brief');
  assert.equal(cert.ok, false, 'the gate must refuse it');
  assert.ok(cert.violations.length > 0);
  const names = cert.violations.map((v) => v.name ?? v.invariant ?? String(v));
  assert.ok(
    names.some((n) => String(n).includes('no-post-without-prior-approval')),
    `expected the approval invariant to fail, got ${JSON.stringify(names)}`
  );

  // Refused means unregistered: not merely flagged, unrunnable.
  assert.equal(pf.admitted('unsafe-brief'), false);
  await assert.rejects(
    () => pf.begin('unsafe-brief', 'nightly'),
    /refused by the admission gate/
  );

  const tools = makeTools(pf);
  const { workflows } = await tools.find((x) => x.name === 'workflow_list').handler({});
  assert.equal(workflows.find((w) => w.name === 'unsafe-brief').admitted, false);
});

test('a run outlives the process: restart re-offers the open work order', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-restart-'));
  const dbPath = join(dir, 'restart.sqlite');
  const opts = {
    workflowsDir: join(ROOT, 'workflows'),
    dbPath, agent: 'openworker/cowork', instance: 'acme', pollMs: 20,
    leaseMs: 400, // a short lease so the test does not wait on a production one
  };
  // Session 1: start the run, get to the approval step, then die.
  const first = await new Polyflow(opts).start();
  const t1 = makeTools(first);
  const call1 = (n, a) => t1.find((x) => x.name === n).handler(a);

  let v = await call1('workflow_start', { workflow: 'customer-brief', key: 'nightly-2026-08-25' });
  v = await call1('workflow_report', { order_id: v.next[0].order_id, result: { count: 3 } });
  v = await call1('workflow_report', { order_id: v.next[0].order_id, result: {} });
  assert.equal(v.state.briefState, 'review');
  assert.equal(v.next[0].tool, 'ask_user');
  const instance = v.instance;
  const openOrderId = v.next[0].order_id;
  await first.close(); // the process goes away with the order unanswered

  // Session 2: a different process, same store. No conversation, no transcript,
  // no replay — the state was never in the messages to begin with.
  const second = await new Polyflow(opts).start();
  t.after(async () => {
    await second.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });
  const t2 = makeTools(second);
  const call2 = (n, a) => t2.find((x) => x.name === n).handler(a);

  const resumed = await call2('workflow_state', { instance });
  assert.equal(resumed.state.briefState, 'review', 'the run is exactly where it was');

  // The lease expires and the effect is re-claimed, so the order is re-offered
  // with a fresh id — at-least-once, absorbed by the machine.
  const deadline = Date.now() + 10_000;
  let reoffered = [];
  while (Date.now() < deadline && reoffered.length === 0) {
    await new Promise((r) => setTimeout(r, 50));
    reoffered = (await call2('workflow_state', { instance })).next;
  }
  assert.equal(reoffered.length, 1, 'the open work order must be re-offered after restart');
  assert.equal(reoffered[0].tool, 'ask_user');
  assert.equal(reoffered[0].order_id, openOrderId,
    're-delivery of the SAME effect intent — not a second one queued alongside it');

  // Approve it in the second process and the run finishes normally.
  let done = await call2('workflow_report', { order_id: reoffered[0].order_id, result: {} });
  assert.equal(done.state.briefState, 'posting');
  done = await call2('workflow_report', { order_id: done.next[0].order_id, result: {} });
  assert.equal(done.state.briefState, 'posted');

  // Exactly one post across both processes.
  const { journal } = await call2('workflow_journal', { instance });
  assert.equal(journal.filter((r) => r.action === 'POST_DONE' && r.step_kind === 'accepted').length, 1);
});
