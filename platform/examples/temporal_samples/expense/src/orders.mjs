// The machine's orders, as activities. Each order kind is an activity of the
// same name; the two the sample defines are called with the sample's own
// signature (`createExpense(id)`, `payment(id)`), so activities.ts stays byte
// for byte upstream's. The third, `request_approval`, is the person's step.
import { Context } from '@temporalio/activity';
import * as sample from './activities.ts';

export async function createExpense({ id }) {
  return sample.createExpense(id);
}

export async function payment({ id }) {
  return sample.payment(id);
}

/**
 * A person's order. Upstream, the workflow waits for an `approve` or `reject`
 * signal that anyone holding the workflow id can send. Here the request is an
 * open order addressed to the `human` role: the answer is a proposal
 * (`polyflow.propose { action: 'APPROVE' | 'REJECT', orderId, actor }`) that
 * only an actor with that role, or a verified principal, can make. This
 * activity is the request's presence on the worker: it parks, heartbeating,
 * until the run calls it off (answered, timed out, or stopped).
 */
export async function request_approval({ id }) {
  const ctx = Context.current();
  ctx.log.info(`expense ${id}: approval requested (order ${ctx.info.activityId})`);
  for (;;) {
    ctx.heartbeat();
    await ctx.sleep(1000); // rejects with CancelledFailure when the run calls the order off
  }
}
