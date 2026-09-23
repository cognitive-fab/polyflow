import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy, admitPolicy, createGuard, classify, PolicyError, canonical, digest } from '../src/index.mjs';

const BASE = {
  policy: 'customer-comms',
  version: 1,
  effects: {
    fetch_url: { kind: 'fetch', class: 'none', labels: ['reads-untrusted'] },
    read_crm: { kind: 'read', class: 'none', labels: ['reads-private'] },
    ask_approval: { kind: 'approval', class: 'none' },
    slack_send: { kind: 'post', class: 'irreversible', labels: ['egress'] },
    send_email: { kind: 'email', class: 'irreversible', labels: ['egress'] },
    redact: { kind: 'redact', class: 'none' },
    llm: { kind: 'model', class: 'none' },
  },
  rules: [
    { id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' },
    { id: 'at-most-two-posts', type: 'at-most', guards: 'post', n: 2 },
  ],
};

const P = (over = {}) => admitPolicy({ ...BASE, ...over });
const cand = (policy, activity, at = 1000, args = { a: 1 }) => {
  const c = classify(policy, activity);
  return { ...c, target: activity, at, argsDigest: digest(args) };
};

/** Drive a sequence of [activity, ok?] through the guard; returns the decisions. */
function drive(policy, steps) {
  const g = createGuard(policy);
  let s = g.init();
  const out = [];
  let at = 1000;
  for (const [activity, ok = true, args] of steps) {
    const c = cand(policy, activity, (at += 1000), args);
    const d = g.decide(s, c);
    out.push(d);
    if (d.outcome === 'allow') {
      s = g.commit(s, c, d);
      s = g.observe(s, { kind: c.kind, ok });
    }
  }
  return { out, state: s, guard: g };
}

test('requires-prior: no post until an approval has SUCCEEDED, and each approval licenses one post', () => {
  const policy = P();
  const { out } = drive(policy, [['slack_send'], ['ask_approval', false], ['slack_send'], ['ask_approval'], ['slack_send'], ['slack_send']]);
  assert.deepEqual(out.map((d) => d.outcome), ['deny', 'allow', 'deny', 'allow', 'allow', 'deny']);
  assert.deepEqual(out[0].rules, ['no-post-without-approval']);
});

test('at-most counts scheduled effects, and every failing rule is reported together', () => {
  const policy = P();
  const { out } = drive(policy, [['ask_approval'], ['slack_send'], ['ask_approval'], ['slack_send'], ['ask_approval'], ['slack_send']]);
  assert.equal(out[5].outcome, 'deny');
  assert.deepEqual(out[5].rules, ['at-most-two-posts'], 'the third approval is unused: only the count fails');
  const both = drive(policy, [['ask_approval'], ['slack_send'], ['ask_approval'], ['slack_send'], ['slack_send']]).out[4];
  assert.deepEqual(both.rules.sort(), ['at-most-two-posts', 'no-post-without-approval']);
});

test('a denial carries a witness: the rule, the fix sentence, the sequence and what is allowed now', () => {
  const policy = P();
  const { out } = drive(policy, [['ask_approval', false], ['slack_send']]);
  const w = out[1].witness;
  assert.equal(w.rules[0].id, 'no-post-without-approval');
  assert.equal(w.rules[0].fix, "run 'approval' and wait for it to succeed before 'post' (each 'approval' licenses one 'post')");
  assert.deepEqual(w.sequence.map((t) => [t.kind, t.ok]), [['approval', false]]);
  assert.ok(w.allowedNow.includes('approval') && !w.allowedNow.includes('post'));
  assert.match(out[1].message, /^no-post-without-approval: run 'approval'/);
});

test('implies-prior only needs the prior to have been ORDERED', () => {
  const policy = P({ rules: [{ id: 'draft-before-send', type: 'implies-prior', guards: 'email', prior: 'model' }] });
  const { out } = drive(policy, [['send_email'], ['llm', false], ['send_email']]);
  assert.deepEqual(out.map((d) => d.outcome), ['deny', 'allow', 'allow']);
});

test('never-after: a kind or a signal closes the door for good', () => {
  const policy = P({ rules: [{ id: 'no-post-after-cancel', type: 'never-after', guards: 'post', after: { signal: 'CANCEL' } }] });
  const g = createGuard(policy);
  let s = g.init();
  assert.equal(g.decide(s, cand(policy, 'slack_send')).outcome, 'allow');
  s = g.signal(s, 'CANCEL', 5);
  assert.equal(g.decide(s, cand(policy, 'slack_send')).outcome, 'deny');
});

test('trifecta: untrusted + private + egress escalates; without the untrusted read it is allowed', () => {
  const policy = P({ rules: [{ id: 'trifecta', type: 'trifecta', outcome: 'escalate' }], escalation: { role: 'approver', timeoutMs: 60000 } });
  const tainted = drive(policy, [['fetch_url'], ['read_crm'], ['send_email']]);
  assert.equal(tainted.out[2].outcome, 'escalate');
  const clean = drive(policy, [['read_crm'], ['send_email']]);
  assert.equal(clean.out[1].outcome, 'allow');
});

test('trifecta: a declared declassification step clears the taint until the next untrusted read', () => {
  const policy = P({ rules: [{ id: 'trifecta', type: 'trifecta', declassify: 'redact' }] });
  const { out } = drive(policy, [['fetch_url'], ['read_crm'], ['redact'], ['send_email'], ['fetch_url'], ['send_email']]);
  assert.deepEqual(out.map((d) => d.outcome), ['allow', 'allow', 'allow', 'allow', 'allow', 'deny']);
});

test('an effects budget stops the call that would exceed it, with the budget in the witness', () => {
  const policy = P({ rules: [{ id: 'tool-calls', type: 'budget', metric: 'effects', max: 2 }] });
  const { out } = drive(policy, [['llm'], ['llm'], ['llm']]);
  assert.deepEqual(out.map((d) => d.outcome), ['allow', 'allow', 'deny']);
  assert.match(out[2].witness.rules[0].fix, /budget 'tool-calls' is exhausted \(2 of 2 effects\)/);
});

test('a metered budget reads the result field it names, and nothing else of the result', () => {
  const policy = P({ rules: [{ id: 'tokens', type: 'budget', metric: 'tokens', from: 'usage.total_tokens', max: 1000, kinds: ['model'] }] });
  const g = createGuard(policy);
  let s = g.init();
  for (const used of [600, 500]) {
    const c = cand(policy, 'llm');
    const d = g.decide(s, c);
    assert.equal(d.outcome, 'allow');
    s = g.observe(g.commit(s, c, d), { kind: 'model', ok: true, result: { usage: { total_tokens: used }, text: 'secret' } });
  }
  assert.equal(g.decide(s, cand(policy, 'llm')).outcome, 'deny');
  assert.ok(!JSON.stringify(s).includes('secret'), 'the result body never enters guard state');
});

test('rate: at most n per window, measured in workflow time', () => {
  const policy = P({ rules: [{ id: 'rate', type: 'rate', guards: 'post', n: 2, perMs: 10_000 }] });
  const g = createGuard(policy);
  let s = g.init();
  const at = [1000, 2000, 3000, 12_500];
  const outcomes = at.map((t) => {
    const c = cand(policy, 'slack_send', t);
    const d = g.decide(s, c);
    if (d.outcome === 'allow') s = g.commit(s, c, d);
    return d.outcome;
  });
  assert.deepEqual(outcomes, ['allow', 'allow', 'deny', 'allow']);
});

test('approvals bind to one effect: kind AND canonical arguments, consumed once (CapLease scenarios)', () => {
  const policy = P({
    rules: [{ id: 'approve-each-email', type: 'requires-prior', guards: 'email', prior: 'approval', bind: 'per-effect' }],
    escalation: { role: 'approver', timeoutMs: 60000 },
  });
  const g = createGuard(policy);
  let s = g.init();
  const email100 = { ...cand(policy, 'send_email', 1, { to: 'a@x', amount: 100 }), proposal: 'p1' };
  assert.equal(g.decide(s, email100).outcome, 'escalate');
  s = g.grant(s, { id: 'ap-1', kind: 'email', argsDigest: email100.argsDigest, proposal: 'p1', principal: 'alice', at: 2 });
  // replan with a different amount: the approval does not transfer
  const email900 = { ...cand(policy, 'send_email', 3, { to: 'a@x', amount: 900 }), proposal: 'p2' };
  assert.equal(g.decide(s, email900).outcome, 'escalate');
  // the approved effect goes through once...
  const d = g.decide(s, email100);
  assert.equal(d.outcome, 'allow');
  assert.equal(d.approval, 'ap-1');
  s = g.commit(s, email100, d);
  // ...and a second identical effect needs a fresh approval
  assert.equal(g.decide(s, email100).outcome, 'escalate');
  // ...as does the same arguments under a NEW proposal, even before the first is consumed
  const s1 = g.grant(g.init(), { id: 'ap-9', kind: 'email', argsDigest: email100.argsDigest, proposal: 'p1', at: 2 });
  assert.equal(g.decide(s1, { ...email100, proposal: 'p7' }).outcome, 'escalate');
  // granting the same approval id twice is idempotent (a retried Update)
  const s2 = g.grant(g.grant(s, { id: 'ap-2', kind: 'email', argsDigest: email100.argsDigest, at: 4 }), { id: 'ap-2', kind: 'email', argsDigest: email100.argsDigest, at: 4 });
  assert.equal(s2.approvals.filter((a) => a.id === 'ap-2').length, 1);
});

test('an approval never overrides a deny', () => {
  const policy = P({
    rules: [
      { id: 'approve-each-post', type: 'requires-prior', guards: 'post', prior: 'approval', bind: 'per-effect' },
      { id: 'no-posts', type: 'at-most', guards: 'post', n: 0, forbid: true },
    ],
    escalation: { role: 'approver', timeoutMs: 1000 },
  });
  const g = createGuard(policy);
  const c = cand(policy, 'slack_send');
  const s = g.grant(g.init(), { id: 'ap', kind: 'post', argsDigest: c.argsDigest, at: 1 });
  assert.equal(g.decide(s, c).outcome, 'deny');
});

test('unlabelled activities: report allows and says so; deny refuses with a witness', () => {
  const report = drive(P(), [['mystery_tool']]);
  assert.equal(report.out[0].outcome, 'allow');
  assert.deepEqual(report.out[0].rules, ['unlabelled']);
  const strict = drive(P({ unlabelled: 'deny' }), [['mystery_tool']]);
  assert.equal(strict.out[0].outcome, 'deny');
  assert.match(strict.out[0].message, /'mystery_tool' is not declared/);
});

test('the guard is pure: the same inputs give byte-identical states and decisions', () => {
  const steps = [['fetch_url'], ['ask_approval'], ['slack_send'], ['read_crm'], ['slack_send'], ['send_email']];
  const a = drive(P(), steps);
  const b = drive(P(), steps);
  assert.equal(canonical(a.state), canonical(b.state));
  assert.equal(canonical(a.out), canonical(b.out));
});

test('property: over random sequences, no allowed post ever lacks an unconsumed successful approval', () => {
  const policy = P();
  const acts = ['ask_approval', 'slack_send', 'llm', 'fetch_url'];
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let trial = 0; trial < 300; trial++) {
    const g = createGuard(policy);
    let s = g.init();
    let licences = 0; let posts = 0;
    for (let i = 0; i < 12; i++) {
      const act = acts[Math.floor(rand() * acts.length)];
      const ok = rand() > 0.3;
      const c = cand(policy, act, i * 1000);
      const d = g.decide(s, c);
      if (d.outcome !== 'allow') continue;
      if (act === 'slack_send') {
        assert.ok(licences > 0, `trial ${trial}: post allowed without a licence`);
        assert.ok(posts < 2, `trial ${trial}: third post allowed`);
        licences--; posts++;
      }
      s = g.observe(g.commit(s, c, d), { kind: c.kind, ok });
      if (act === 'ask_approval' && ok) licences++;
    }
  }
});

test('policy admission refuses what it cannot govern, listing every problem', () => {
  assert.throws(() => parsePolicy({ policy: 'x', version: 1, effects: {} }), /declares no activities/);
  const err = (() => { try { parsePolicy({ ...BASE, rules: [{ id: 'a', type: 'sometimes' }, { id: 'b', type: 'at-most', guards: 'teleport', n: 1 }] }); } catch (e) { return e; } })();
  assert.ok(err instanceof PolicyError);
  assert.equal(err.problems.length, 2);
  assert.match(err.problems[0], /unknown rule type 'sometimes'/);
  assert.match(err.problems[1], /kind 'teleport' is not declared/);
  assert.throws(() => parsePolicy({ ...BASE, rules: [{ id: 'r', type: 'requires-prior', guards: 'post', prior: 'post' }] }), /cannot require itself/);
  assert.throws(() => parsePolicy({ ...BASE, rules: [{ id: 'r', type: 'trifecta', outcome: 'escalate' }] }), /nobody would be asked/);
});

test('policy admission refuses a rule set that makes its guarded effect unreachable', () => {
  // post needs an approval, and approval needs a post: neither can ever happen.
  assert.throws(() => admitPolicy({
    ...BASE,
    rules: [
      { id: 'a', type: 'requires-prior', guards: 'post', prior: 'approval' },
      { id: 'b', type: 'requires-prior', guards: 'approval', prior: 'post' },
    ],
  }), /kind 'approval' can never be allowed[\s\S]*kind 'post' can never be allowed/);
  assert.throws(() => parsePolicy({ ...BASE, rules: [{ id: 'z', type: 'at-most', guards: 'post', n: 0 }] }), /say "forbid": true/);
});

test('a parsed policy has a stable digest and notes irreversible kinds no rule guards', () => {
  const a = P();
  const b = P();
  assert.equal(a.digest, b.digest);
  assert.deepEqual(a.notes, ["irreversible kind 'email' is guarded by no rule"]);
});
