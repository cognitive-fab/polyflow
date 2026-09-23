// P6-P8 review — the governance service. Each test asserts what the technical
// spec (§11, §13) or doctrine 2 ("no silent-clean paths") says, and fails
// today for the reason in its message. See docs/platform/reviews/P6-P8-review.md.
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

const get = async (path) => (await fetch(`${url}${path}`, { headers: { authorization: 'Bearer t0ken' } })).json();
const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t0ken' }, body: JSON.stringify(body) });

/** A complete, signed, closed run shipped in one delta. */
async function shipRun(ns, wf) {
  const run = { ns, wf, run: 'r1' };
  const l = openLedger({ run });
  l.append('admission', { level: 'guard', policy: { name: 'comms', version: 1, digest: 'sha256:aa' } }, 1000);
  l.append('closure', { outcome: 'completed' }, 1001);
  await httpSink({ url, token: 't0ken' }).write(l.drain(), signHead(run, l.head(), key));
  return run;
}

test('SV1: a signed head is checked when it is written — one worker cannot unverify another run', async () => {
  const victim = await shipRun('acme', 'wf-victim');
  assert.equal((await get('/v1/runs/acme/wf-victim/r1/verify')).ok, true, 'baseline: the victim verifies');
  // Any holder of a write token ships its own (valid) delta, with a "signed head"
  // that names SOMEONE ELSE's run and carries garbage for a signature.
  const own = openLedger({ run: { ns: 'acme', wf: 'wf-other', run: 'r9' } });
  own.append('admission', { level: 'observe', policy: null }, 1000);
  const forgedHead = { run: victim, seq: 1, hash: 'sha256:0', keyId: 'worker2', alg: 'ed25519', sig: 'AAAA' };
  const res = await post('/v1/ledger', { events: own.drain(), signedHead: forgedHead });
  assert.notEqual(res.status, 200, 'SV1: the service stored a head for another run, unverified');
  const v = await get('/v1/runs/acme/wf-victim/r1/verify');
  assert.equal(v.ok, true, `SV1: the victim's record is now reported NOT verified: ${v.problems}`);
});

test('SV2: deltas that arrive out of order (two activities of one workflow, run concurrently) still assemble the whole chain', async () => {
  // Two activities scheduled in one workflow task carry consecutive deltas.
  // Nothing orders their execution: another worker, or another slot, runs the
  // second first. Both deliveries happen; the service should end up whole.
  const run = { ns: 'acme', wf: 'wf-parallel', run: 'r1' };
  const l = openLedger({ run });
  l.append('admission', { level: 'observe', policy: null }, 1000);
  l.append('proposal', { source: 'workflow', action: 'search' }, 1001);
  const first = l.drain();
  const firstHead = l.head();
  l.append('proposal', { source: 'workflow', action: 'fetch' }, 1001);
  l.append('closure', { outcome: 'completed' }, 1002);
  const second = l.drain();
  const sink = httpSink({ url, token: 't0ken' });
  await sink.write(second, signHead(run, l.head(), key)).catch(() => {}); // the exporter swallows this (it never fails an activity)
  await sink.write(first, signHead(run, firstHead, key));
  const held = await get('/v1/runs/acme/wf-parallel/r1');
  assert.equal(held.events.length, 4, `SV2: the service holds ${held.events.length} of 4 events and will refuse every later delta of this run as a gap`);
});

test('SV3: an evidence pack over nothing is not evidence that record-keeping holds', async () => {
  const pack = await get('/v1/evidence?ns=nobody-here');
  assert.equal(pack.runs.total, 0);
  const art12 = pack.mapping.find((m) => m.item === 'Art. 12 record-keeping');
  assert.notEqual(art12.holds, true, 'SV3: zero runs recorded, and Art. 12 "holds" (doctrine 2: empty is never green)');
});

test('SV4: an escalation nobody answered is not human oversight that holds', async () => {
  const run = { ns: 'unanswered', wf: 'wf-esc', run: 'r1' };
  const l = openLedger({ run });
  l.append('admission', { level: 'guard', policy: { name: 'comms', version: 1, digest: 'sha256:aa' } }, 1000);
  l.append('proposal', { source: 'workflow', action: 'send_email' }, 1001);
  l.append('verdict', { proposal: 'p1', outcome: 'escalated', rules: ['trifecta'], approvalId: 'ap-p1' }, 1001);
  l.append('verdict', { proposal: 'p1', outcome: 'denied', rules: ['trifecta'], reason: 'escalation ap-p1: no decision within 60000 ms' }, 61001);
  l.append('closure', { outcome: 'failed' }, 61002);
  await httpSink({ url, token: 't0ken' }).write(l.drain(), signHead(run, l.head(), key));
  const pack = await get('/v1/evidence?ns=unanswered');
  assert.equal(pack.oversight.escalations, 1);
  assert.equal(pack.oversight.decisions, 0);
  const art14 = pack.mapping.find((m) => m.item === 'Art. 14 human oversight');
  assert.notEqual(art14.holds, true, 'SV4: every escalation timed out with no person deciding, and Art. 14 "holds"');
});

test('SV5: a certificate whose body was edited after it was signed is refused by the registry', async () => {
  const { buildCertificate, sealCertificate } = await import('@cognitive-fab/polyflow-kernel');
  const { signCertificate } = await import('@cognitive-fab/polyflow-temporal');
  const cert = signCertificate(sealCertificate(buildCertificate({
    machine: 'm', artefacts: { machine: 'sha256:1' }, guarantees: ['g1'], checks: [{ name: 'check-effects', ok: true }], domains: 'sha256:d', toolchain: {}, issuedAt: '2026-09-22T00:00:00Z',
  })), key);
  cert.guarantees.push('no-refund-without-approval'); // a guarantee nobody checked
  const res = await post('/v1/certificates', cert);
  assert.equal(res.status, 422, 'SV5: the edited certificate was registered');
  const pack = await get('/v1/evidence?ns=acme');
  assert.ok(!pack.certificates.some((c) => c.guarantees.includes('no-refund-without-approval')), 'SV5: the evidence pack states a guarantee that was never checked');
});

test('SV6: a forked delta is refused whole — its events past the fork are not stored on top of the real chain', async () => {
  const run = { ns: 'acme', wf: 'wf-fork', run: 'r1' };
  const real = openLedger({ run });
  real.append('admission', { level: 'observe', policy: null }, 1000);
  real.append('proposal', { source: 'workflow', action: 'search' }, 1001);
  real.append('proposal', { source: 'workflow', action: 'fetch' }, 1002);
  await httpSink({ url, token: 't0ken' }).write(real.drain(), signHead(run, real.head(), key));
  // A fork from seq 0: different events at 1 and 2 (conflicts), and a new seq 3.
  const forked = openLedger({ run, head: { seq: 0, hash: real.events()[0].hash } });
  forked.append('proposal', { source: 'workflow', action: 'wire_money' }, 1001);
  forked.append('proposal', { source: 'workflow', action: 'wire_more' }, 1002);
  forked.append('closure', { outcome: 'completed' }, 1003);
  const res = await post('/v1/ledger', { events: forked.drain() });
  assert.equal(res.status, 409, 'the conflicts are reported');
  const held = await get('/v1/runs/acme/wf-fork/r1');
  assert.equal(held.events.length, 3, `SV6: the forger's seq 3 was stored after the real seq 2 — the run can never verify again (${held.events.map((e) => e.body.action ?? e.kind).join(', ')})`);
});
