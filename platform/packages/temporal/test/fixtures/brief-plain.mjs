// The customer-brief job written as a plain Temporal workflow: correct, durable,
// and with nothing stopping a second fire from doing the job a second time.
import { proxyActivities } from '@temporalio/workflow';

const acts = proxyActivities({ startToCloseTimeout: '10s' });

export async function briefPlain() {
  const { count } = await acts.fetch_tickets({ window: 'yesterday' });
  if (count === 0) return 'nothing to post';
  await acts.draft_brief({ ticketCount: count });
  await acts.request_approval({ ticketCount: count });
  await acts.post_brief({ ticketCount: count });
  return 'posted';
}
