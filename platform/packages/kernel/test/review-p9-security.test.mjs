// P9 security review — the pure kernel. Each test asserts a security property
// the platform relies on and fails today for the reason in its message.
// See docs/platform/reviews/P9-security-review.md (finding ids in the titles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  verifyPrincipal, sealHeader, redact, redactOutbound, admitPolicy, parsePlan, admitPlan,
} from '../src/index.mjs';

test('SEC-PR2: an oversized principal token is refused before any hashing (it runs in an Update validator, inside the 2 s deadlock budget)', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const trust = { idp: publicKey.export({ type: 'spki', format: 'pem' }) };
  const now = 1_000_000;
  // Everything checked before the signature is public: a trusted keyId, a
  // future exp, the namespace as aud. Only the padding is the attacker's.
  const token = { body: { keyId: 'idp', id: 'mallory', exp: now + 60_000, aud: 'default', pad: 'A'.repeat(1_500_000) }, sig: 'A'.repeat(86) + '==' };
  const t0 = performance.now();
  const v = verifyPrincipal(token, { trust, now, audience: 'default' });
  const ms = performance.now() - t0;
  assert.equal(v.ok, false);
  // The validator verifies it, then the handler verifies it again: 2x this per Update.
  assert.ok(ms < 100, `SEC-PR2: refusing one forged 1.5 MB token took ${ms.toFixed(0)} ms of pure-JS SHA-512 in the workflow isolate; the validator and the handler each spend it, so one unauthenticated Update exceeds the 2 s deadlock detector`);
});

test('SEC-SH1: two different header bodies sealed at the same (run, purpose, seq) never share a nonce', () => {
  const hk = { keyId: 'k1', key: randomBytes(32).toString('base64') };
  const at = { runId: 'run-1', purpose: 'ledger', seq: 7 };
  // After a worker upgrade (plugin or policy change) a replayed execution can
  // reach seq 7 again with different events; so can a Python and a TS worker.
  const a = sealHeader({ events: [{ seq: 7, body: { outcome: 'allowed' } }] }, hk, at);
  const b = sealHeader({ events: [{ seq: 7, body: { outcome: 'denied!' } }] }, hk, at);
  assert.notEqual(a.nonce, b.nonce, `SEC-SH1: both bodies were sealed under nonce ${a.nonce}: ChaCha20 keystream reuse (ct1 XOR ct2 = pt1 XOR pt2) and a reused Poly1305 key, which lets a reader of history forge a tag for that nonce`);
});

test('SEC-RD1: redaction removes the common credential shapes, not only key=value and a few vendor prefixes', () => {
  const secrets = {
    'JSON password': '{"password":"hunter2hunter2"}',
    'YAML/colon token': 'token: 9f8e7d6c5b4a39281706f5e4',
    'HTTP Basic auth': 'Authorization: Basic YWxpY2U6aHVudGVyMmh1bnRlcjI=',
    'credentials in a URL': 'fetch failed for https://alice:hunter2hunter2@db.internal:5432/prod',
    'a JWT': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlc2lnbmF0dXJlc2ln',
    'a PEM private key': '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF\n-----END PRIVATE KEY-----',
    'a Google API key': 'key=AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q',
    // Assembled at run time: a literal placeholder still trips GitHub's push protection.
    'a Slack webhook': ['https://hooks.slack.com', 'services', 'T00000000', 'B00000000', 'X'.repeat(24)].join('/'),
  };
  const needles = {
    'JSON password': 'hunter2hunter2', 'YAML/colon token': '9f8e7d6c5b4a39281706f5e4', 'HTTP Basic auth': 'YWxpY2U6aHVudGVyMmh1bnRlcjI',
    'credentials in a URL': 'hunter2hunter2', 'a JWT': 'eyJzdWIiOiJhbGljZSJ9', 'a PEM private key': 'MC4CAQAwBQYDK2VwBCIEIJ',
    'a Google API key': 'AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q', 'a Slack webhook': 'XXXXXXXXXXXXXXXXXXXXXXXX',
  };
  const leaked = Object.entries(secrets).filter(([name, text]) => redact(text, 10_000).includes(needles[name]) || redactOutbound(text).includes(needles[name])).map(([name]) => name);
  assert.deepEqual(leaked, [], `SEC-RD1: these reach the ledger (failure text) or Jev (outbound) verbatim: ${leaked.join('; ')}`);
});

test('SEC-PL1: an agent-authored plan cannot make admission throw or overrun a workflow task', () => {
  const policy = admitPolicy({ policy: 'p9', version: 1, effects: { noop: { kind: 'noop' } }, rules: [] });
  // A plan is agent input. A plain chain is ONE order, so the evaluation budget
  // (20,000 guard decisions) never trips; the recursion depth and the O(n^2)
  // copying do.
  const steps = Array.from({ length: 5000 }, (_, i) => ({ id: `s${i}`, activity: 'noop', args: {}, after: i ? [`s${i - 1}`] : [] }));
  const t0 = performance.now();
  let verdict;
  let thrown = null;
  try { verdict = admitPlan(policy, parsePlan({ steps }), {}).verdict; } catch (err) { thrown = err; }
  const ms = performance.now() - t0;
  // Response: a PlanError is the refusal the finding prescribes (bounded plans); proposePlan turns it into a
  // non-retryable PolyflowPlanRefused, so the workflow CALL fails, not the task. Anything else is the bug.
  if (thrown?.name === 'PlanError') thrown = null;
  assert.equal(thrown, null, `SEC-PL1: admitPlan threw ${thrown?.name}: ${thrown?.message} after ${ms.toFixed(0)} ms. In the isolate that is not a TemporalFailure, so the workflow TASK fails and retries forever: the agent wedges its own run`);
  assert.ok(ms < 2000, `SEC-PL1: parse + admission took ${ms.toFixed(0)} ms (${verdict}), past the 2 s deadlock detector`);
});

test('SEC-ED1: a small-order (identity) key in a trust store does not verify every forged token', () => {
  // A misconfigured trust entry (all-zero-ish key material, a truncated PEM)
  // can decode to the identity point; R = identity, S = 0 then verifies for ANY message.
  const identity = Buffer.alloc(32); identity[0] = 1;
  const trust = { idp: identity.toString('base64') };
  const now = 1_000;
  const forged = { body: { keyId: 'idp', id: 'root', roles: ['approver', 'operator'], aud: 'default', exp: now + 60_000 }, sig: Buffer.concat([identity, Buffer.alloc(32)]).toString('base64') };
  const v = verifyPrincipal(forged, { trust, now, audience: 'default' });
  assert.equal(v.ok, false, 'SEC-ED1: a signature nobody made verified: small-order public keys (and R points) are not rejected');
});

test('SEC-PL2: plan admission cost does not scale with the size of agent-chosen step arguments', () => {
  const policy = admitPolicy({ policy: 'p9', version: 1, effects: { noop: { kind: 'noop' } }, rules: [] });
  // 14 independent steps whose args are 1 KB each: the guard-evaluation budget
  // bounds the walk, but every evaluation re-hashes the step's arguments in
  // pure-JS SHA-256 (stepArgsDigest is not memoised). 20 KB args take ~20 s.
  const blob = 'x'.repeat(1000);
  const steps = Array.from({ length: 14 }, (_, i) => ({ id: `w${i}`, activity: 'noop', args: { blob } }));
  const t0 = performance.now();
  const v = admitPlan(policy, parsePlan({ steps }), {});
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `SEC-PL2: admission of a 14-step plan with 1 KB arguments took ${ms.toFixed(0)} ms (${v.verdict}) inside one workflow task`);
});
