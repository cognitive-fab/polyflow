// Fixtures for test/policy-ramp.test.mjs (P4.6).
import { proxyActivities, condition, defineSignal, setHandler } from '@temporalio/workflow';

export * from '@cognitive-fab/polyflow-temporal/workflows';

const acts = proxyActivities({ startToCloseTimeout: '10s' });
export const go = defineSignal('go');

/** Asks for approval `approvals` times, then waits to be told to post. */
export async function approveThenPost({ approvals = 1 } = {}) {
  let ready = false;
  setHandler(go, () => { ready = true; });
  for (let i = 0; i < approvals; i++) await acts.ask_approval({ i });
  await condition(() => ready);
  return acts.slack_send({ text: 'brief' });
}
