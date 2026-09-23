// T2: version 1 has a bug (a TypeError: a workflow TASK failure, fixable by redeploy).
import { proxyActivities } from '@temporalio/workflow';
const acts = proxyActivities({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } });
export async function evolving() {
  await acts.think({ i: 0 });
  const o = null;
  o.boom();
  return await acts.post({ text: 'unreachable' });
}
