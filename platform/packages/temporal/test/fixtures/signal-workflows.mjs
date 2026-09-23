// A workflow that waits for a signal, then acts.
import { proxyActivities, defineSignal, setHandler, condition } from '@temporalio/workflow';

const acts = proxyActivities({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } });
export const go = defineSignal('go');

export async function waitsForGo() {
  let ready = false;
  setHandler(go, () => { ready = true; });
  await condition(() => ready);
  return acts.post({ text: 'went' });
}
