// Review P2/P3 (docs/platform/reviews/P2-P3-review.md): kernel findings.
// Each test asserts what the spec claims; each failed against the code as
// reviewed and is kept as a regression test. Ids match the review's findings table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitPolicy, createGuard, classify, digest, parseKeyPolicy, deriveKey, createHost } from '../src/index.mjs';

const BASE = {
  policy: 'review', version: 1,
  effects: {
    fetch_url: { kind: 'fetch', class: 'none', labels: ['reads-untrusted'] },
    read_crm: { kind: 'read', class: 'none', labels: ['reads-private'] },
    ask_approval: { kind: 'approval', class: 'none' },
    send_email: { kind: 'email', class: 'irreversible', labels: ['egress'] },
    llm: { kind: 'model', class: 'none' },
    redact: { kind: 'redact', class: 'none' },
  },
  rules: [],
};
const cand = (policy, activity, at = 1000, args = { a: 1 }) => ({ ...classify(policy, activity), target: activity, at, argsDigest: digest(args) });

test('review G2: an unlabelled effect that escalates can be approved (FR-GRD.4: the decision is bound to that one effect)', () => {
  const p = admitPolicy({ ...BASE, unlabelled: 'escalate', escalation: { role: 'approver', timeoutMs: 1000 } });
  const g = createGuard(p);
  const c = cand(p, 'mystery_tool');
  let s = g.init();
  assert.equal(g.decide(s, c).outcome, 'escalate');
  s = g.grant(s, { id: 'ap-p1', kind: c.kind, argsDigest: c.argsDigest, principal: 'alice', at: 2 });
  // The interceptor re-decides after the grant; today the unlabelled branch
  // returns before any approval is consulted, so a human "approve" becomes a deny.
  assert.equal(g.decide(s, c).outcome, 'allow');
});

test('review G3: an approval granted for an effect that was then denied is not reusable by a later proposal (FR-HUM.3)', () => {
  const p = admitPolicy({
    ...BASE,
    rules: [
      { id: 'approve-each-email', type: 'requires-prior', guards: 'email', prior: 'approval', bind: 'per-effect' },
      { id: 'one-email-per-second', type: 'rate', guards: 'email', n: 1, perMs: 1000 },
    ],
    escalation: { role: 'approver', timeoutMs: 60_000 },
  });
  const g = createGuard(p);
  let s = g.init();
  // Two emails escalate concurrently (Promise.all in one workflow task).
  const x = cand(p, 'send_email', 10, { to: 'x' });
  const y = cand(p, 'send_email', 10, { to: 'y' });
  assert.equal(g.decide(s, x).outcome, 'escalate');
  assert.equal(g.decide(s, y).outcome, 'escalate');
  // y is approved first and goes out.
  // (The interceptor grants with the proposal id the escalation was raised for;
  // this test models that — see the response section of the review.)
  s = g.grant(s, { id: 'ap-y', kind: 'email', argsDigest: y.argsDigest, proposal: 'p-y', at: 20 });
  s = g.commit(s, { ...y, at: 20, proposal: 'p-y' }, g.decide(s, { ...y, at: 20, proposal: 'p-y' }));
  // x is approved, but the rate rule now denies it: the effect never happens.
  s = g.grant(s, { id: 'ap-x', kind: 'email', argsDigest: x.argsDigest, proposal: 'p-x', at: 30 });
  assert.equal(g.decide(s, { ...x, at: 30, proposal: 'p-x' }).outcome, 'deny');
  // Much later the agent re-plans and sends x again: a fresh proposal, a fresh
  // step. Nobody is asked — the stale approval for the DENIED proposal licenses it.
  const later = g.decide(s, { ...x, at: 60_000, proposal: 'p-x2' });
  assert.equal(later.outcome, 'escalate', `stale approval ${later.approval} was reused`);
});

test('review G4: a metered budget cannot be refunded by a negative reading', () => {
  const p = admitPolicy({ ...BASE, rules: [{ id: 'tokens', type: 'budget', metric: 'tokens', from: 'usage.total_tokens', max: 1000, kinds: ['model'] }] });
  const g = createGuard(p);
  let s = g.init();
  const outcomes = [];
  for (const used of [900, -100_000, 900, 900, 900]) {
    const c = cand(p, 'llm');
    const d = g.decide(s, c);
    outcomes.push(d.outcome);
    if (d.outcome === 'allow') s = g.observe(g.commit(s, c, d), { kind: 'model', ok: true, result: { usage: { total_tokens: used } } });
  }
  assert.deepEqual(outcomes, ['allow', 'allow', 'deny', 'deny', 'deny'], `meter ended at ${s.meters.tokens}`);
});

test('review G5: an effects budget with no kinds counts unlabelled effects AND stops them (FR-GRD.7)', () => {
  const p = admitPolicy({ ...BASE, rules: [{ id: 'tool-calls', type: 'budget', metric: 'effects', max: 2 }] });
  const g = createGuard(p);
  let s = g.init();
  const outcomes = [];
  for (let i = 0; i < 4; i++) {
    const c = cand(p, 'mystery_tool');
    const d = g.decide(s, c);
    outcomes.push(d.outcome);
    if (d.outcome === 'allow') s = g.commit(s, c, d);
  }
  assert.deepEqual(outcomes, ['allow', 'allow', 'deny', 'deny'], `meter says ${s.meters['tool-calls']} of 2 used`);
});

test('review G6: a declassification ordered BEFORE the reads does not declassify them', () => {
  const p = admitPolicy({ ...BASE, rules: [{ id: 'trifecta', type: 'trifecta', declassify: 'redact' }] });
  const g = createGuard(p);
  let s = g.init();
  const step = (activity) => { const c = cand(p, activity); const d = g.decide(s, c); assert.equal(d.outcome, 'allow'); s = g.commit(s, c, d); return c; };
  step('redact');                                   // scheduled first...
  step('fetch_url'); s = g.observe(s, { kind: 'fetch', ok: true });
  step('read_crm'); s = g.observe(s, { kind: 'read', ok: true });
  s = g.observe(s, { kind: 'redact', ok: true });   // ...completes after both reads
  assert.equal(g.decide(s, cand(p, 'send_email')).outcome, 'deny', 'the redaction never saw the data it is credited with cleaning');
});

test('review A1: policy admission stays fast on an 11-kind policy with one forbidden kind', () => {
  const effects = {};
  for (let i = 0; i < 11; i++) effects[`a${i}`] = { kind: `k${i}`, class: 'none' };
  const t = Date.now();
  admitPolicy({ policy: 'wide', version: 1, effects, rules: [{ id: 'never-k0', type: 'at-most', guards: 'k0', n: 0, forbid: true }] });
  const ms = Date.now() - t;
  assert.ok(ms < 2_000, `admission took ${ms} ms (the reachability search is exponential in the number of kinds)`);
});

test('review K1: two different inputs never derive the same run key', () => {
  const kp = parseKeyPolicy({ template: 'order-{id}', fields: { id: {} } });
  // String.prototype.replaceAll interprets $-patterns in the replacement.
  assert.notEqual(deriveKey(kp, { id: 'a$$b' }), deriveKey(kp, { id: 'a$b' }));
  assert.equal(deriveKey(kp, { id: 'x$&y' }), 'order-x$&y');
  // A value is substituted into the template, then the NEXT field's placeholder is searched for in the result.
  const two = parseKeyPolicy({ template: '{a}-{b}' });
  assert.notEqual(deriveKey(two, { a: '{b}', b: 'x' }), deriveKey(two, { a: 'x', b: 'x' }));
});

test('review H2: a permanent failure with no onFailure falls through to onExhausted, as polyrun does', () => {
  // polyrun workers.mjs: a {permanent} error with no onFailure is retried until
  // exhausted, then dispatches onExhausted. The host returns null: the machine never hears of it.
  const mod = {
    instance: () => ({ lastStep: () => ({ classification: 'mutated' }) }),
    init() {}, getState: () => ({ s: 'x' }), setState() {}, actions: { GAVE_UP: () => {} },
  };
  const host = createHost({ module: mod, contract: { stateKeys: [{ name: 's' }] }, manifest: { effects: { charge: { onExhausted: { action: 'GAVE_UP' } } } } });
  assert.deepEqual(host.completionAction('charge', 'permanent', { message: 'card declined' }), { action: 'GAVE_UP', data: { reason: 'exhausted' } });
});

test('review H3: a scalar activity result maps to the same completion data as polyrun ({})', () => {
  const mod = {
    instance: () => ({ lastStep: () => ({ classification: 'mutated' }) }),
    init() {}, getState: () => ({ s: 'x' }), setState() {}, actions: { DONE: () => {} },
  };
  const host = createHost({ module: mod, contract: { stateKeys: [{ name: 's' }] }, manifest: { effects: { ping: { onSuccess: { action: 'DONE' } } } } });
  // polyrun: mapCompletion(hook, { result }, result && typeof result === 'object' ? result : {})
  assert.deepEqual(host.completionAction('ping', 'success', { result: 'ok' }), { action: 'DONE', data: {} });
});
