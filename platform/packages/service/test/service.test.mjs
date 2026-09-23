// P8 — the governance service: a sink that notices tampering, verification
// and reports over what it holds, the evidence pack, metrics, and auth.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '@cognitive-fab/polyflow-kernel';
import { signHead, generateSigningKey } from '@cognitive-fab/polyflow-temporal';
import { Store, createService, httpSink } from '../src/index.mjs';

const key = generateSigningKey('worker');
const trust = { worker: key.publicKeyPem };
let service;
let url;
before(async () => {
  service = createService({ store: new Store(':memory:'), trust, tokens: ['t0ken'] });
  await new Promise((r) => service.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${service.server.address().port}`;
});
after(() => service.server.close());

const get = async (path, token = 't0ken') => fetch(`${url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

/** A run exported in two carriers, the way the plugin exports it. */
async function shipRun(wf, { deny = false, human = false } = {}) {
  const sink = httpSink({ url, token: 't0ken' });
  const run = { ns: 'acme', wf, run: 'r1' };
  const l = openLedger({ run });
  l.append('admission', { level: 'guard', policy: { name: 'comms', version: 1, digest: 'sha256:aa' } }, 1000);
  l.append('proposal', { source: 'workflow', action: 'slack_send' }, 1001);
  if (deny) l.append('verdict', { proposal: 'p1', outcome: 'denied', rules: ['no-post-without-approval'], reason: 'run approval first' }, 1001);
  else l.append('verdict', { proposal: 'p1', outcome: 'allowed', rules: ['no-post-without-approval'] }, 1001);
  await sink.write(l.drain(), signHead(run, l.head(), key));
  if (human) {
    l.append('verdict', { proposal: 'p3', outcome: 'escalated', rules: ['trifecta'] }, 1002);
    l.append('proposal', { source: 'human', action: 'approve', principal: { id: 'alice', verified: false } }, 1003);
  }
  l.append('closure', { outcome: 'completed' }, 1004);
  await sink.write(l.drain(), signHead(run, l.head(), key));
  return { run, l };
}

test('a run shipped through the http sink verifies end to end and reports deterministically', async () => {
  await shipRun('wf-ok');
  const v = await (await get('/v1/runs/acme/wf-ok/r1/verify')).json();
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(v.verdict, 'closed-and-signed');
  const a = await (await get('/v1/runs/acme/wf-ok/r1/report')).text();
  const b = await (await get('/v1/runs/acme/wf-ok/r1/report')).text();
  assert.equal(a, b, 'the report is byte-identical for the same record');
  assert.match(a, /record: \*\*verified\*\* \(closed-and-signed\)/);
  assert.match(a, /Consistency checks, not proofs/);
});

test('a different event offered at a seq the service holds is refused and becomes a tamper alert', async () => {
  const { run } = await shipRun('wf-tamper');
  const forged = openLedger({ run });
  forged.append('admission', { level: 'observe', policy: null }, 1000); // a different seq 0
  const res = await fetch(`${url}/v1/ledger`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t0ken' }, body: JSON.stringify({ events: forged.drain() }) });
  assert.equal(res.status, 409);
  const { alerts } = await (await get('/v1/alerts')).json();
  assert.ok(alerts.some((x) => x.wf === 'wf-tamper' && x.seq === 0));
  const v = await (await get('/v1/runs/acme/wf-tamper/r1/verify')).json();
  assert.equal(v.ok, true, 'the held record is untouched');
  const metrics = await (await get('/metrics')).text();
  assert.match(metrics, /polyflow_tamper_alerts [1-9]/);
});

test('a delta that skips ahead is held back, not stored with a hole, and a hole that stays open is a gap alert', async () => {
  // A service of its own, with a clock the test moves.
  let now = 1_000_000;
  const store = new Store(':memory:', { now: () => now, gapAfterMs: 60_000, maxPendingPerRun: 1 });
  const own = createService({ store, trust, tokens: ['t0ken'] });
  await new Promise((r) => own.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${own.server.address().port}`;
  const post = (events) => fetch(`${base}/v1/ledger`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t0ken' }, body: JSON.stringify({ events }) });
  try {
    const run = { ns: 'acme', wf: 'wf-gap', run: 'r1' };
    const l = openLedger({ run });
    l.append('admission', {}, 1);
    const first = l.drain();
    l.append('proposal', { action: 'x' }, 2);
    const second = l.drain();
    l.append('proposal', { action: 'y' }, 3);
    const third = l.drain();
    const res = await post(second);
    assert.equal(res.status, 202, 'held back');
    assert.equal((await res.json()).pending, 1);
    assert.equal(store.read(run).events.length, 0, 'nothing is stored with a hole');
    const full = await post(third);
    assert.equal(full.status, 409, 'the hold-back buffer is bounded');
    assert.match((await full.json()).error, /gap/);
    now += 61_000;
    const gaps = store.alerts().filter((a) => a.kind === 'gap' && a.wf === 'wf-gap');
    assert.ok(gaps.some((g) => g.seq === 0 && g.through === 0), `the open hole is reported: ${JSON.stringify(gaps)}`);
    const fill = await fetch(`${base}/v1/ledger`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t0ken' }, body: JSON.stringify({ events: first, signedHead: signHead(run, first.at(-1), key) }) });
    assert.equal(fill.status, 200);
    assert.equal((await fill.json()).applied, 1, 'the held-back delta is applied when the hole fills');
    assert.equal((await post(third)).status, 200, 'and the run continues');
    assert.equal(store.read(run).events.length, 3);
    assert.equal(store.pendingCount(), 0, 'no hole is left open');
  } finally {
    own.server.close();
  }
});

test('the http sink retries a refusal that can clear, and returns a conflict for the exporter to report', async () => {
  const replies = [{ status: 503, body: { error: 'down' } }, { status: 409, body: { error: 'gap: full' } }, { status: 200, body: { written: 1, skipped: 0, conflicts: [] } }];
  let calls = 0;
  const fake = async () => { const r = replies[calls++]; return { status: r.status, json: async () => r.body }; };
  const sink = httpSink({ url: 'http://x', token: 't', fetch: fake, sleep: async () => {} });
  assert.deepEqual(await sink.write([{}], null), { written: 1, skipped: 0, conflicts: [] });
  assert.equal(calls, 3);
  calls = 0;
  const conflict = httpSink({ url: 'http://x', token: 't', fetch: async () => ({ status: 409, json: async () => ({ conflicts: [2] }) }), sleep: async () => {} });
  assert.deepEqual((await conflict.write([{}], null)).conflicts, [2]);
  const refused = httpSink({ url: 'http://x', token: 't', fetch: async () => { calls++; return { status: 422, json: async () => ({ error: 'bad head' }) }; }, sleep: async () => {} });
  await assert.rejects(refused.write([{}], null), /bad head/);
  assert.equal(calls, 1, 'a 422 is not retried');
});

test('/metrics derives the FR-OBS.2 counters from the held ledgers, in OpenMetrics form', async () => {
  const run = { ns: 'metrics', wf: 'wf-m', run: 'r1' };
  const l = openLedger({ run });
  l.append('admission', { level: 'guard', policy: { name: 'p', version: 1, digest: 'sha256:aa' } }, 1000);
  l.append('verdict', { proposal: 'p1', outcome: 'denied', rules: ['spend'], witness: { rules: [{ id: 'spend', type: 'budget', fix: '' }] } }, 1001);
  l.append('verdict', { proposal: 'p2', outcome: 'escalated', rules: ['trifecta'], approvalId: 'ap-p2', role: 'approver' }, 1002);
  l.append('proposal', { source: 'human', action: 'approve', approvalId: 'ap-p2', principal: { id: 'a', verified: false } }, 1003);
  l.append('closure', { outcome: 'completed' }, 1004);
  await httpSink({ url, token: 't0ken' }).write(l.drain(), signHead(run, l.head(), key));
  const m = await (await get('/metrics')).text();
  for (const line of [
    '# TYPE polyflow_verdicts counter',
    'polyflow_verdicts_total{ns="metrics",rule="spend",outcome="denied"} 1',
    'polyflow_escalations_total{ns="metrics",role="approver"} 1',
    'polyflow_budget_denials_total{ns="metrics",rule="spend"} 1',
    'polyflow_admissions_total{ns="metrics",level="guard"} 1',
    'polyflow_human_decisions_total{ns="metrics",decision="approve"} 1',
    'polyflow_closures_total{ns="metrics",outcome="completed"} 1',
    '# TYPE polyflow_poisoned counter',
  ]) assert.ok(m.includes(line), `missing: ${line}`);
  assert.ok(!/^# TYPE \S+_total /m.test(m), 'a counter family is named without _total');
  assert.match(m, /# EOF\n$/);
});

test('the service answers bad requests as bad requests', async () => {
  const bad = await fetch(`${url}/v1/ledger`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t0ken' }, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await get('/v1/evidence?ns=acme&from=abc')).status, 400, 'a period that is not one');
  assert.equal((await get('/v1/evidence?ns=acme&from=10&to=5')).status, 400, 'an empty period');
  assert.equal((await get('/v1/evidence?ns=acme&from=2026-01-01T00:00:00Z')).status, 200, 'an ISO date');
});

test('a token scoped to namespaces writes and reads only those', async () => {
  const own = createService({ store: new Store(':memory:'), trust, tokens: [{ token: 'acme-only', namespaces: ['acme'] }] });
  await new Promise((r) => own.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${own.server.address().port}`;
  try {
    const ship = (ns) => {
      const l = openLedger({ run: { ns, wf: 'w', run: 'r' } });
      l.append('admission', {}, 1);
      const events = l.drain();
      return fetch(`${base}/v1/ledger`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer acme-only' }, body: JSON.stringify({ events, signedHead: signHead(events[0].run, events[0], key) }) });
    };
    assert.equal((await ship('acme')).status, 200);
    assert.equal((await ship('globex')).status, 403);
    const read = await fetch(`${base}/v1/evidence?ns=globex`, { headers: { authorization: 'Bearer acme-only' } });
    assert.equal(read.status, 403);
  } finally {
    own.server.close();
  }
});

test('the evidence pack maps the record to the frameworks, and says what it cannot show', async () => {
  await shipRun('wf-denied', { deny: true });
  await shipRun('wf-human', { human: true });
  const pack = await (await get('/v1/evidence?ns=acme')).json();
  assert.ok(pack.runs.total >= 3);
  assert.equal(pack.rules['no-post-without-approval'].denied, 1);
  assert.equal(pack.oversight.escalations, 1);
  assert.equal(pack.oversight.decisions, 1);
  assert.equal(pack.oversight.principalsVerified, 0);
  const art14 = pack.mapping.find((m) => m.item === 'Art. 14 human oversight');
  assert.equal(art14.holds, false, 'a decision by an unverified principal does not count as verified oversight');
  assert.equal(pack.mapping.find((m) => m.item === 'Art. 19/26 log retention').holds, null, 'retention is not something the pack can show');
  assert.match(pack.disclosure, /not proofs/);
});

test('without a token nothing is written and nothing is read', async () => {
  assert.equal((await get('/v1/runs', null)).status, 401);
  const res = await fetch(`${url}/v1/ledger`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  assert.equal((await get('/v1/runs', 'wrong-token')).status, 401);
});

test('the file and memory sinks refuse a forked delta whole, as the service does (review SV6)', async () => {
  const { memorySink, fileSink } = await import('@cognitive-fab/polyflow-temporal');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pf-sink-'));
  try {
    for (const sink of [memorySink(), fileSink(dir)]) {
      const run = { ns: 'acme', wf: `wf-fork-${sink.kind}`, run: 'r1' };
      const real = openLedger({ run });
      real.append('admission', {}, 1000);
      real.append('proposal', { action: 'search' }, 1001);
      real.append('proposal', { action: 'fetch' }, 1002);
      sink.write(real.drain(), null);
      const forked = openLedger({ run, head: { seq: 0, hash: real.events()[0].hash } });
      forked.append('proposal', { action: 'wire_money' }, 1001);
      forked.append('proposal', { action: 'wire_more' }, 1002);
      forked.append('closure', { outcome: 'completed' }, 1003);
      const r = sink.write(forked.drain(), null);
      assert.deepEqual(r.conflicts, [1, 2], sink.kind);
      assert.equal(r.written, 0, sink.kind);
      assert.equal(sink.read(run).events.length, 3, `${sink.kind}: the forger's seq 3 was stored`);
      // A delta that starts at the hole but does not chain from the held head is a fork too.
      const other = openLedger({ run: { ...run, run: 'r1' }, head: { seq: 2, hash: 'sha256:' + '0'.repeat(64) } });
      other.append('closure', { outcome: 'completed' }, 1003);
      assert.deepEqual(sink.write(other.drain(), null).conflicts, [3], `${sink.kind}: an unchained continuation`);
      assert.equal(sink.read(run).events.length, 3);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the exporter waits, bounded, for a delta\'s predecessor before calling it a gap (review SL)', async () => {
  const { memorySink, exporter, verifyBundle, LEDGER_HEADER } = await import('@cognitive-fab/polyflow-temporal');
  const { defaultPayloadConverter } = await import('@temporalio/common');
  const sink = memorySink();
  const errors = [];
  const run = { ns: 'acme', wf: 'wf-ooo', run: 'r1' };
  const factory = exporter({ sink, signingKey: key, onError: (e) => errors.push(e.message) });
  const ctx = { info: { workflowExecution: { workflowId: run.wf, runId: run.run }, workflowNamespace: run.ns } };
  const deliver = (events) => factory(ctx).inbound.execute({ headers: { [LEDGER_HEADER]: defaultPayloadConverter.toPayload({ events }) } }, async () => 'ok');
  const l = openLedger({ run });
  l.append('admission', {}, 1);
  l.append('proposal', { action: 'a' }, 2);
  const first = l.drain();
  l.append('proposal', { action: 'b' }, 3);
  l.append('closure', { outcome: 'completed' }, 4);
  const second = l.drain();
  const late = deliver(second); // starts first, and waits
  await new Promise((r) => setTimeout(r, 50));
  await deliver(first);
  await late;
  assert.deepEqual(errors, []);
  const { events, heads } = sink.read(run);
  const v = verifyBundle({ events, heads, trust: { [key.keyId]: key.publicKeyPem } });
  assert.equal(v.ok, true, v.problems.join('; '));
});

/** A service of its own for one test. */
async function ownService(options) {
  const svc = createService({ store: new Store(':memory:'), tokens: ['t0ken'], ...options });
  await new Promise((r) => svc.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${svc.server.address().port}`;
  const post = (body, token = 't0ken') => fetch(`${base}/v1/ledger`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { svc, base, post, close: () => svc.server.close() };
}

test('trust is per namespace, and a run\'s first delta needs a signed head where the namespace has a key (SEC-SV2)', async () => {
  const other = generateSigningKey('globex-key');
  const s = await ownService({ trust: { worker: { pem: key.publicKeyPem, namespaces: ['acme'] }, 'globex-key': { pem: other.publicKeyPem, namespaces: ['globex'] } } });
  try {
    const first = (ns, wf) => { const l = openLedger({ run: { ns, wf, run: 'r' } }); l.append('admission', {}, 1); return l.drain(); };
    const a = first('acme', 'w1');
    assert.equal((await s.post({ events: a })).status, 422, 'an unsigned first delta cannot start (or squat) a run');
    assert.equal((await s.post({ events: a, signedHead: signHead(a[0].run, a[0], other) })).status, 422, 'globex\'s key does not vouch for acme');
    assert.equal((await s.post({ events: a, signedHead: signHead(a[0].run, a[0], key) })).status, 200);
    const n = first('nokeys', 'w1');
    assert.equal((await s.post({ events: n })).status, 200, 'a namespace with no trusted key takes unsigned deltas, as before');
  } finally { s.close(); }
});

test('the service is hardened: /metrics needs a token by default, requests are rate limited, sockets time out (SEC-SV3)', async () => {
  const s = await ownService({ rateLimit: { perSecond: 1, burst: 3 } });
  try {
    assert.equal((await fetch(`${s.base}/metrics`)).status, 401);
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(`${s.base}/v1/runs`, { headers: { authorization: 'Bearer t0ken' } })).status);
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
    assert.equal(statuses.at(-1), 429);
    assert.ok(s.svc.server.requestTimeout > 0 && s.svc.server.headersTimeout > 0);
  } finally { s.close(); }
});

test('held-back deltas expire into a gap alert, and a run with no seq 0 stops taking them (SEC-SV1)', () => {
  let now = 0;
  const store = new Store(':memory:', { now: () => now, gapAfterMs: 1000, expireAfterMs: 4000, noStartGraceMs: 2000 });
  const ahead = (wf) => { const l = openLedger({ run: { ns: 'acme', wf, run: 'r' } }); l.append('admission', {}, 1); l.append('proposal', {}, 2); l.append('proposal', {}, 3); return l.drain(); };
  const d = ahead('never-starts');
  assert.equal(store.writeEvents(d.slice(1, 2)).pending, 1);
  now = 2500;
  assert.match(store.writeEvents(d.slice(2)).refused, /no seq 0/);
  now = 5000;
  assert.equal(store.pendingCount(), 0, 'expired');
  assert.ok(store.alerts().some((a) => a.kind === 'gap' && a.wf === 'never-starts' && a.seq === 0));
});
