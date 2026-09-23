import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import { createHost, digest } from '@cognitive-fab/polyflow-kernel';
import machines from './machines.cjs';

const { echo } = proxyActivities({ startToCloseTimeout: '10s' });

// P0.2: a SAM v2 strict machine steps inside the workflow isolate, and an
// activity sits between steps so replay has to re-run the machine.
export async function machineSpike(script) {
  const host = createHost(machines['customer-brief']);
  let state = host.init();
  const kinds = [];
  let seq = 0;
  for (const [action, data] of script) {
    const r = host.step(state, action, data, { runKey: workflowInfo().workflowId, seq: seq++, now: Date.now() });
    if (r.poisoned) throw new Error(r.poisoned);
    kinds.push(...r.effects.map((e) => e.kind));
    state = r.post;
    await echo(action);
  }
  return { state, kinds, digest: digest(state) };
}
