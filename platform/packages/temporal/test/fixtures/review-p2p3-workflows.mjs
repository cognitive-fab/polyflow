// Fixtures for the P2/P3 review (docs/platform/reviews/P2-P3-review.md).
import { proxyActivities, proxyLocalActivities, getExternalWorkflowHandle, defineSignal, setHandler, condition, CancellationScope, sleep } from '@temporalio/workflow';

export * from '@cognitive-fab/polyflow-temporal/workflows';

const ping = defineSignal('ping');

/** Waits for one `ping` signal. */
export async function pingTarget() {
  let got = false;
  setHandler(ping, () => { got = true; });
  await condition(() => got);
  return 'pinged';
}

/** Signals another workflow: an effect FR-GRD.1 says crosses the guard. */
export async function signaller({ targetId }) {
  await getExternalWorkflowHandle(targetId).signal(ping);
  return 'sent';
}

// A local activity whose second attempt comes after a timer backoff (the
// backoff is longer than the local retry threshold), i.e. a Temporal retry.
const la = proxyLocalActivities({
  startToCloseTimeout: '5s', localRetryThreshold: '1s',
  retry: { initialInterval: '2s', backoffCoefficient: 1, maximumAttempts: 3 },
});

/** One post, done as a local activity that fails once and then succeeds. */
export async function localPoster({ text }) {
  return la.slack_send({ text });
}

const acts = proxyActivities({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } });

/** Sends one email but gives up after a second; then lingers so the run can be inspected. */
export async function impatientEmailer({ to }) {
  let outcome;
  try {
    outcome = await CancellationScope.withTimeout(1000, () => acts.send_email({ to }));
  } catch (err) {
    outcome = `gave up: ${err.name}`;
  }
  await sleep(4000);
  return outcome;
}
