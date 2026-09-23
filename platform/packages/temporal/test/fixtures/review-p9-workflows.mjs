// Fixtures for test/review-p9-temporal.test.mjs (P9 review, AP1).
import { proxyActivities, condition, defineUpdate, setHandler } from '@temporalio/workflow';

const acts = proxyActivities({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } });
export const edit = defineUpdate('edit');

/**
 * An agent loop that keeps working on its message object after handing it to a
 * tool call — as a loop that shares one draft between turns does. The call is
 * parked for approval; the loop edits the draft while it waits.
 */
export async function editWhileParked({ to, body }) {
  const draft = { to, body };
  let edited = false;
  setHandler(edit, ({ to: next }) => { draft.to = next; edited = true; return draft; });
  const sent = acts.send_email(draft);
  await condition(() => edited);
  return sent;
}
