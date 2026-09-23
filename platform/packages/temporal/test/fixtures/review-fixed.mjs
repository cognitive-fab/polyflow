// T2: version 2 is the fix the operator deploys.
import { proxyActivities } from '@temporalio/workflow';
const acts = proxyActivities({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } });
export async function evolving() {
  await acts.think({ i: 0 });
  return await acts.post({ text: 'fixed' });
}
