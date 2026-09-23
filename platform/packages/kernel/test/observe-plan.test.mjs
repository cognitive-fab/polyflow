// P6 kernel: calibrated observations (FR-JEV) and plan admission (FR-PLAN).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBattery, factsFrom, jevRequest, BatteryError, parsePlan, admitPlan, admitPolicy, PlanError, createGuard, classify, digest } from '../src/index.mjs';

const MODEL = 'jev-2026-06';
const CAL = { n: 80, positives: 30, negatives: 50, assertPrecision: 0.95, refutePrecision: 0.93, model: MODEL };
const battery = parseBattery({
  name: 'refund',
  model: MODEL,
  questions: {
    reason_stated: { type: 'noul', instructions: 'Does the message state a reason for the refund?', assertAt: 0.85, refuteAt: 0.15, calibration: CAL },
    fraud_signal: { type: 'noul', instructions: 'Does the message show signs of fraud?', assertAt: 0.9, refuteAt: 0.1, calibration: CAL },
    uncalibrated: { type: 'noul', instructions: 'Is the customer a VIP?', assertAt: 0.8, refuteAt: 0.2 },
    other_model: { type: 'noul', instructions: 'Is it urgent?', assertAt: 0.8, refuteAt: 0.2, calibration: { ...CAL, model: 'jev-2025-01' } },
    illustrative: { type: 'noul', instructions: 'Is it late?', assertAt: 0.8, refuteAt: 0.2, calibration: { ...CAL, illustrative: true } },
  },
});

test('a probability clears a band or yields NO fact — never a default false', () => {
  const r = factsFrom(battery, {
    reason_stated: { noul: 0.93 }, fraud_signal: { noul: 0.5 }, uncalibrated: { noul: 0.99 }, other_model: { noul: 0.99 }, illustrative: { noul: 0.99 },
  });
  assert.deepEqual(r.facts, { reason_stated: true });
  assert.deepEqual(r.abstained, ['fraud_signal']);
  assert.deepEqual(r.inert, ['uncalibrated', 'other_model', 'illustrative'], 'uncalibrated, calibrated on another model, or on an illustrative sample: inert whatever it answers');
  assert.deepEqual(r.p, { reason_stated: 0.93, fraud_signal: 0.5 }, 'the probabilities are kept, rounded, for calibration tracking');
  assert.equal(parseBattery({ name: 'b', model: MODEL, questions: { q: { type: 'noul', instructions: 'q', assertAt: 0.8, refuteAt: 0.2, calibration: { ...CAL, illustrative: true } } } }, { allowIllustrative: true }).questions.q.calibrated, true, 'development may opt in');
  assert.equal(factsFrom(battery, { reason_stated: { noul: 0.05 } }).facts.reason_stated, false);
  assert.ok(!('fraud_signal' in factsFrom(battery, {}).facts), 'a missing answer is unknown, not false');
});

test('choice questions and overlapping bands are refused at declaration', () => {
  assert.throws(() => parseBattery({ name: 'x', questions: { intent: { type: 'choice', instructions: 'which', criteria: ['a', 'b'] } } }), /drops secondary intents silently/);
  assert.throws(() => parseBattery({ name: 'x', questions: { a: { type: 'noul', instructions: 'q', assertAt: 0.3, refuteAt: 0.6 } } }), BatteryError);
  assert.throws(() => parseBattery({ name: 'x', questions: { a: { type: 'noul', instructions: 'q', assertAt: 1.2, refuteAt: 0.6 } } }), BatteryError);
  assert.throws(() => parseBattery({ name: 'x', questions: { a: { type: 'noul', instructions: 'q', assertAt: 0.505, refuteAt: 0.5 } } }), /jitter/);
  assert.throws(() => parseBattery({ name: 'x', questions: { a: { type: 'score', instructions: 'q', levels: ['a', 'b'] } } }), /'score' is refused/);
});

test('the Jev request carries the questions and never the bands', () => {
  const body = jevRequest(battery, { message: 'hi' });
  assert.deepEqual(Object.keys(body.questions).sort(), ['fraud_signal', 'illustrative', 'other_model', 'reason_stated', 'uncalibrated']);
  assert.equal(body.model, MODEL, 'the model the battery was calibrated on');
  assert.ok(!JSON.stringify(body).includes('assertAt'));
});

const POLICY = admitPolicy({
  policy: 'comms', version: 1,
  effects: {
    ask_approval: { kind: 'approval', class: 'none' },
    slack_send: { kind: 'post', class: 'irreversible', labels: ['egress'] },
    fetch_url: { kind: 'fetch', class: 'none', labels: ['reads-untrusted'] },
    read_crm: { kind: 'read', class: 'none', labels: ['reads-private'] },
    send_email: { kind: 'email', class: 'irreversible', labels: ['egress'] },
  },
  unlabelled: 'deny',
  rules: [
    { id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' },
    { id: 'trifecta', type: 'trifecta', outcome: 'escalate' },
    { id: 'tool-calls', type: 'budget', metric: 'effects', max: 4 },
  ],
  escalation: { role: 'approver', timeoutMs: 60_000 },
});

test('a plan whose every order satisfies the policy is admitted before any step runs', () => {
  const plan = parsePlan({ steps: [{ id: 'ask', activity: 'ask_approval' }, { id: 'post', activity: 'slack_send', after: ['ask'] }] });
  assert.deepEqual(admitPlan(POLICY, plan), { verdict: 'admitted', escalations: [], statesChecked: 2 });
});

test('a plan with ONE bad execution order is refused, and the witness is that order', () => {
  // ask and post are unordered: "post first" is a permitted order, and it posts unapproved.
  const plan = parsePlan({ steps: [{ id: 'ask', activity: 'ask_approval' }, { id: 'post', activity: 'slack_send' }] });
  const r = admitPlan(POLICY, plan);
  assert.equal(r.verdict, 'refused');
  assert.deepEqual(r.witness.order, ['post', 'ask']);
  assert.equal(r.witness.step, 'post');
  assert.deepEqual(r.witness.rules, ['no-post-without-approval']);
});

test('a plan that will need a person says which steps, and is admitted', () => {
  const plan = parsePlan({ steps: [{ id: 'web', activity: 'fetch_url' }, { id: 'crm', activity: 'read_crm' }, { id: 'mail', activity: 'send_email', after: ['web', 'crm'] }] });
  const r = admitPlan(POLICY, plan);
  assert.equal(r.verdict, 'admitted');
  assert.deepEqual(r.escalations, ['mail']);
});

test('a plan has only the authority the run has left: budget already spent, kinds never declared', () => {
  const g = createGuard(POLICY);
  let s = g.init();
  for (let i = 0; i < 3; i++) {
    const c = { ...classify(POLICY, 'fetch_url'), target: 'fetch_url', argsDigest: digest({ i }), at: i };
    s = g.commit(s, c, g.decide(s, c));
  }
  const two = parsePlan({ steps: [{ id: 'a', activity: 'ask_approval' }, { id: 'b', activity: 'ask_approval', after: ['a'] }] });
  assert.equal(admitPlan(POLICY, two, { state: s }).verdict, 'refused', 'the parent has 1 of 4 calls left; the plan wants 2');
  assert.equal(admitPlan(POLICY, two).verdict, 'admitted');
  const rogue = parsePlan({ steps: [{ id: 'x', activity: 'wire_money' }] });
  assert.deepEqual(admitPlan(POLICY, rogue).witness.rules, ['unlabelled']);
});

test('a plan that needs more than its exploration budget is bounded, never admitted; cycles are refused', () => {
  const wide = parsePlan({ steps: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, activity: 'ask_approval' })) });
  assert.equal(admitPlan(POLICY, wide, { maxEvaluations: 4 }).verdict, 'bounded', 'the budget runs out before the check can finish');
  assert.throws(() => parsePlan({ steps: [{ id: 'a', activity: 'x', after: ['b'] }, { id: 'b', activity: 'x', after: ['a'] }] }), PlanError);
});
