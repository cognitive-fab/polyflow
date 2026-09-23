// Fixture for review P4/P5 finding GC1: a workflow that posts once, continues
// as new, and tries to post again. Under `at-most-one-post` the second post
// should be denied: the guard's state is specified to round-trip through
// Continue-as-New (tech spec §4.1).
import { proxyActivities, continueAsNew } from '@temporalio/workflow';

const acts = proxyActivities({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } });

export async function postAcrossContinueAsNew({ round = 1 } = {}) {
  if (round === 1) {
    await acts.ask_approval({});
    await acts.slack_send({ text: 'first' });
    await continueAsNew({ round: 2 });
  }
  // Approval asked again, so only at-most-one-post can refuse the second post.
  await acts.ask_approval({});
  try {
    await acts.slack_send({ text: 'second' });
    return { secondPost: 'allowed' };
  } catch (err) {
    const f = err?.cause ?? err;
    return { secondPost: f?.type === 'PolyflowDenied' ? 'denied' : `failed: ${f?.message}` };
  }
}
