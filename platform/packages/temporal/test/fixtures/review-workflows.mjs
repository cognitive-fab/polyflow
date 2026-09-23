// Adversarial review fixtures (docs/platform/reviews/P0-P1-review.md).
// Ordinary workflows; nothing here knows Polyflow exists.
import { proxyActivities, executeChild, workflowInfo, ApplicationFailure } from '@temporalio/workflow';

const acts = proxyActivities({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } });

/** T1: a workflow with a retry policy whose first attempt fails. */
export async function retried() {
  await acts.think({ i: workflowInfo().attempt });
  if (workflowInfo().attempt === 1) throw ApplicationFailure.retryable('first attempt fails');
  return await acts.post({ text: 'second attempt' });
}

/** T4: a child workflow start, then an activity. */
export async function child({ fail = false } = {}) {
  await acts.think({ i: 99 });
  if (fail) throw ApplicationFailure.nonRetryable('child failed');
  return 'child-done';
}
export async function parent({ failChild = false } = {}) {
  let r;
  try { r = await executeChild(child, { args: [{ fail: failChild }], workflowId: workflowInfo().workflowId + '-child' }); } catch { r = 'child-failed'; }
  await acts.post({ text: String(r) });
  return r;
}

/** T5: an activity still in flight when the workflow returns. */
export async function detachedNoAwait() {
  const slow = acts.search({ q: 'slow' });
  slow.catch(() => {});
  await acts.think({ i: 0 });
  return 'done';
}
