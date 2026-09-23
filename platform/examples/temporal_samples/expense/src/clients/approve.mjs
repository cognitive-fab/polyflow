// Upstream: start the workflow, wait 50 ms, send `approveSignal`, print the
// result. Here the approval is a proposal against the open order addressed to
// the `human` role; the run's id is derived from the expense id, so a second
// start attaches to the first instead of paying twice.
import { Client, Connection } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { startGoverned, loadMachineDir } from '@cognitive-fab/polyflow-temporal';
import { fileURLToPath } from 'node:url';

const { descriptor } = loadMachineDir(fileURLToPath(new URL('../../machine/', import.meta.url)));

async function run() {
  const config = loadClientConnectConfig();
  const connection = await Connection.connect(config.connectionOptions);
  const client = new Client({ connection });

  const expenseId = 'my-business-id';
  const { handle, status } = await startGoverned(client, { descriptor, input: { expenseId }, taskQueue: 'expense' });
  console.log(`${status}: ${handle.workflowId}`);

  // At a "later time", the approver answers the open request.
  let order;
  while (!order) {
    const s = await handle.query('polyflow.state');
    order = s.orders.find((o) => o.kind === 'request_approval');
    if (!order) await new Promise((r) => setTimeout(r, 50));
  }
  await handle.executeUpdate('polyflow.propose', {
    args: [{ action: 'APPROVE', orderId: order.orderId, actor: { id: 'manager', roles: ['human'] } }],
  });

  console.log('Done:', (await handle.result()).state); // Done: { expenseState: 'completed', ... }
}
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
