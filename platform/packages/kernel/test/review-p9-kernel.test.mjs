// P9 review — the policy ramp gate (plan P4.6) in the pure kernel. Each test
// asserts what the plan row, the module header or the acquisition brief says
// the gate does, and fails today for the reason in its message.
// See docs/platform/reviews/P9-review.md (finding ids in the titles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitPolicy, createGuard, classify, vetPolicyChange } from '../src/index.mjs';

/** The guard state a run holds after these effects ran and succeeded under `policy`. */
function runUnder(policy, calls) {
  const g = createGuard(policy);
  let s = g.init();
  let at = 1;
  for (const { activity, result } of calls) {
    const c = { ...classify(policy, activity), target: activity, argsDigest: `d${at}`, at };
    const d = g.decide(s, c);
    assert.equal(d.outcome, 'allow', `fixture: '${activity}' is allowed under ${policy.policy} v${policy.version}`);
    s = g.observe(g.commit(s, c, d), { kind: c.kind, ok: true, result });
    at += 1;
  }
  return { state: s, at };
}

/** Would this worker, with this policy, run `activity` now? The question a run in flight actually asks. */
const allows = (policy, state, activity, at) => createGuard(policy).decide(state, { ...classify(policy, activity), target: activity, argsDigest: 'next', at }).outcome === 'allow';

test('RP1: a run allowed an ACTIVITY now, and denied it under the new policy, is pinned (the gate compares kind names, not what the run may do)', () => {
  // slack_send moves to a new kind that needs a manager first; teams_send keeps
  // the kind name 'post', so 'post' is "still allowed" and nothing looks revoked.
  const oldP = admitPolicy({
    policy: 'comms', version: 1, unlabelled: 'deny',
    effects: { slack_send: { kind: 'post', class: 'reversible' }, teams_send: { kind: 'post', class: 'reversible' }, ask_manager: { kind: 'manager', class: 'none' } },
    rules: [],
  });
  const newP = admitPolicy({
    policy: 'comms', version: 2, unlabelled: 'deny',
    effects: { slack_send: { kind: 'external-post', class: 'reversible' }, teams_send: { kind: 'post', class: 'reversible' }, ask_manager: { kind: 'manager', class: 'none' } },
    rules: [{ id: 'manager-before-external', type: 'requires-prior', guards: 'external-post', prior: 'manager' }],
  });
  const { state, at } = runUnder(oldP, [{ activity: 'teams_send' }]);
  assert.ok(allows(oldP, state, 'slack_send', at) && !allows(newP, state, 'slack_send', at), 'fixture: slack_send is allowed now and denied after the ramp');
  const r = vetPolicyChange(oldP, newP, [{ workflowId: 'run-1', guard: state, at }]);
  assert.equal(r.decisions[0].decision, 'pin', `RP1: the gate says '${r.decisions[0].decision}' (ok: ${r.ok}) for a run the new policy denies slack_send, which it may call now: allowedNow compares kind names ('post' is in both), not the activities the run can call`);
});

test('RP2: a run allowed an undeclared activity now (unlabelled: report) is pinned when the new policy denies it (unlabelled: deny)', () => {
  const base = { policy: 'agent', effects: { post: { kind: 'post', class: 'reversible' } }, rules: [] };
  const oldP = admitPolicy({ ...base, version: 1, unlabelled: 'report' });
  const newP = admitPolicy({ ...base, version: 2, unlabelled: 'deny' });
  const { state, at } = runUnder(oldP, [{ activity: 'web_fetch' }]);
  assert.ok(allows(oldP, state, 'web_fetch', at) && !allows(newP, state, 'web_fetch', at), 'fixture: web_fetch is allowed now and denied after the ramp');
  const r = vetPolicyChange(oldP, newP, [{ workflowId: 'run-1', guard: state, at }]);
  assert.equal(r.ok, false, `RP2: the ramp passes (${JSON.stringify(r.decisions)}): allowedNow lists declared kinds only, so an effect the run is allowed through 'unlabelled' is never compared`);
});

test('RP3 (plan P4.6 row): a tightened budget a run in flight has already used is reported, and the ramp is refused', () => {
  // The run has spent 90 of 100. The new policy caps spend at 50 — and names the
  // rule differently. Its meter starts at zero, so the run may spend 50 MORE
  // (140 in all) under a policy whose cap is 50.
  const effects = { llm: { kind: 'model', class: 'none' } };
  const oldP = admitPolicy({ policy: 'spend', version: 1, unlabelled: 'deny', effects, rules: [{ id: 'usd', type: 'budget', metric: 'usd', from: 'cost', max: 100, kinds: ['model'] }] });
  const newP = admitPolicy({ policy: 'spend', version: 2, unlabelled: 'deny', effects, rules: [{ id: 'usd-per-run', type: 'budget', metric: 'usd', from: 'cost', max: 50, kinds: ['model'] }] });
  const { state, at } = runUnder(oldP, [{ activity: 'llm', result: { cost: 90 } }]);
  assert.ok(allows(newP, state, 'llm', at), 'fixture: under the new policy the run starts a fresh 50');
  const r = vetPolicyChange(oldP, newP, [{ workflowId: 'run-1', guard: state, at }]);
  assert.equal(r.ok, false, `RP3: the ramp passes (freshRules ${JSON.stringify(r.freshRules)} is reported and ignored): a run that spent 90 moves to a 50 cap with a fresh meter`);
});

test('RP4: freshRules names exactly the rules whose counters start from zero', () => {
  // at-most counts effects by KIND (state.n), so a new at-most rule sees every
  // post the run already made; a new consuming requires-prior counts CREDITS by
  // rule id, which do start from zero. freshRules has both the wrong way round.
  const effects = { post: { kind: 'post', class: 'reversible' }, ask: { kind: 'approval', class: 'none' } };
  const oldP = admitPolicy({ policy: 'x', version: 1, unlabelled: 'deny', effects, rules: [] });
  const newP = admitPolicy({
    policy: 'x', version: 2, unlabelled: 'deny', effects,
    rules: [{ id: 'one-post', type: 'at-most', guards: 'post', n: 1 }, { id: 'ask-first', type: 'requires-prior', guards: 'post', prior: 'approval' }],
  });
  const { state, at } = runUnder(oldP, [{ activity: 'ask' }, { activity: 'post' }]);
  const r = vetPolicyChange(oldP, newP, [{ workflowId: 'run-1', guard: state, at }]);
  assert.deepEqual(r.freshRules, ['ask-first'], `RP4: freshRules is ${JSON.stringify(r.freshRules)}: 'one-post' counts the post already made (s.n), 'ask-first' starts with no credit although the run asked`);
});
