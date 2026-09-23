// P6-P8 review — observation bands and plan admission in the kernel. Each test
// asserts what the functional spec (FR-JEV, FR-PLAN) or the polyx-jev spec it
// cites (JF2, JF3) says, and fails today for the reason in its message.
// See docs/platform/reviews/P6-P8-review.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBattery, factsFrom } from '../src/observe.mjs';
import { parsePlan, admitPlan } from '../src/plan.mjs';
import { admitPolicy } from '../src/admit-policy.mjs';

const calibrated = { n: 120, positives: 60, negatives: 60, assertPrecision: 0.95, refutePrecision: 0.95 };
const noul = parseBattery({ name: 'b', questions: { fraud_signal: { type: 'noul', instructions: 'fraud?', assertAt: 0.8, refuteAt: 0.2, calibration: calibrated } } });

test('KJ1: a probability outside [0, 1] is a malformed answer, and yields no fact', () => {
  // A proxy, a vendor bug, or a changed response shape (percent instead of a
  // probability) must not become "fraud: true" or "fraud: false".
  const high = factsFrom(noul, { fraud_signal: { noul: 87 } });
  const low = factsFrom(noul, { fraud_signal: { noul: -0.4 } });
  assert.deepEqual(high.facts, {}, `KJ1: p = 87 became a fact: ${JSON.stringify(high.facts)}`);
  assert.deepEqual(low.facts, {}, `KJ1: p = -0.4 became a fact: ${JSON.stringify(low.facts)}`);
});

test('KJ2: a score question can produce a fact from the answers Jev actually returns', () => {
  // jev-lab (seams.py, results.json): a three-level score answers 1.99, 1.98 —
  // an expectation over the levels, not an index. factsFrom accepts only an
  // integer index, so every real answer abstains, and an integer, if one ever
  // came, would be used with no band and no calibration at all (JF2, JF3).
  // Either refuse score at declaration (as choice is), or band it; accepting it and never answering is the bug.
  // Response: refused at declaration (the first option the finding offers).
  assert.throws(() => parseBattery({ name: 'b', questions: { goodwill: { type: 'score', instructions: 'how much goodwill?', levels: ['none', 'some', 'a lot'], calibration: calibrated } } }), /'score' is refused/);
});

test('KJ3: a calibration record that does not meet JF3.2/JF3.4 leaves the question inert', () => {
  // "Bands come from a labelled sample, never by hand" (observe.mjs header).
  // Minimum sample 60 with >= 15 of each label (JF3.2); assert precision >= 0.90 (JF3.4).
  const b = parseBattery({ name: 'b', questions: {
    one_label: { type: 'noul', instructions: 'q', assertAt: 0.8, refuteAt: 0.2, calibration: { n: 1, positives: 0, negatives: 0 } },
    imprecise: { type: 'noul', instructions: 'q', assertAt: 0.8, refuteAt: 0.2, calibration: { n: 120, positives: 60, negatives: 60, assertPrecision: 0.4 } },
  } });
  const out = factsFrom(b, { one_label: { noul: 0.99 }, imprecise: { noul: 0.99 } });
  assert.deepEqual(out.facts, {}, `KJ3: a one-item, zero-label "calibration" and a 40%-precise band both produce facts: ${JSON.stringify(out.facts)}`);
});

test('KP1: a plan that a metered budget will stop halfway is not admitted as if it could run to the end', () => {
  // FR-PLAN.4: "at most the parent's remaining budget". admitPlan observes every
  // step with no result, so a metered budget (usd, tokens) is never spent in the
  // check: three $0.60 model calls under a $1 budget are "admitted", and the
  // guard stops the plan after the second call, with the first two done.
  const policy = admitPolicy({
    policy: 'spend', version: 1, unlabelled: 'deny',
    effects: { llm: { kind: 'model', class: 'none' }, publish: { kind: 'publish', class: 'irreversible' } },
    rules: [{ id: 'usd', type: 'budget', metric: 'usd', from: 'usage.usd', max: 1, kinds: ['model'] }],
  });
  const plan = parsePlan({ steps: [
    { id: 'draft', activity: 'llm' }, { id: 'publish', activity: 'publish', after: ['draft'] },
    { id: 'summarise', activity: 'llm', after: ['publish'] }, { id: 'translate', activity: 'llm', after: ['summarise'] },
  ] });
  const v = admitPlan(policy, plan);
  assert.ok(v.verdict !== 'admitted' || /usd|budget/.test(JSON.stringify(v)), `KP1: admitted with no word about the metered budget: ${JSON.stringify(v)}`);
});
