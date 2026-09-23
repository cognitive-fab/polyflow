// Fixtures for test/review-p6p8-temporal.test.mjs (the P6-P8 review).
import { sleep, proxyActivities } from '@temporalio/workflow';
import { proposePlan } from '@cognitive-fab/polyflow-temporal/workflows';

export * from '@cognitive-fab/polyflow-temporal/workflows';

/** TP1: one step of an admitted plan fails; the agent is told, and moves on. */
export async function failingPlanAgent() {
  const plan = { steps: [
    { id: 'a', activity: 'boom' },
    { id: 'b', activity: 'slow' },
    { id: 'c', activity: 'after_slow', after: ['b'] },
  ] };
  let error = null;
  try { await proposePlan(plan); } catch (err) { error = String(err?.message ?? err); }
  const failedAt = Date.now();
  await sleep('4s'); // the agent thinks about what to do next
  return { error, failedAt };
}

/** TP2: a plan whose step has arguments. */
export async function oneStepPlan() {
  return proposePlan({ steps: [{ id: 'post', activity: 'slack_send', args: { text: 'brief' } }] });
}

/** TP3: an agent that has made `prior` tool calls proposes a plan of two independent seven-step branches. */
export async function wideningPlan({ prior = 0 } = {}) {
  const { noop } = proxyActivities({ startToCloseTimeout: '10s' });
  for (let i = 0; i < prior; i++) await noop();
  const steps = [];
  for (const b of ['x', 'y']) for (let i = 0; i < 7; i++) steps.push({ id: `${b}${i}`, activity: 'noop', after: i ? [`${b}${i - 1}`] : [] });
  const r = await proposePlan({ steps }, { run: false });
  return r.verdict;
}
