import { workflowInfo, condition, makeContinueAsNewFunc, defineSignal, setHandler } from '@temporalio/workflow';
export const go = defineSignal('go');
export async function versioned({ hops = 0 } = {}) {
  let ready = false;
  setHandler(go, () => { ready = true; });
  if (hops === 0) await condition(() => ready);
  if (workflowInfo().targetWorkerDeploymentVersionChanged && hops === 0) {
    await makeContinueAsNewFunc({ initialVersioningBehavior: 'AUTO_UPGRADE' })({ hops: 1 });
  }

  return 'v2:' + hops + ':' + workflowInfo().targetWorkerDeploymentVersionChanged;
}
