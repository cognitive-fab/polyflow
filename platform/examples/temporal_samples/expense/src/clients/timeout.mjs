// Upstream: start with a 1 s timeout and print `{ status: 'TIMED_OUT' }`.
// Here the approval window is part of the certified machine (10 s in
// effects.cjs): start, answer nobody, and the run ends `timed_out` with no
// payment on its path — which admission proved for every path, not just this one.
import { Client, Connection } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { startGoverned, loadMachineDir } from '@cognitive-fab/polyflow-temporal';
import { fileURLToPath } from 'node:url';

const { descriptor } = loadMachineDir(fileURLToPath(new URL('../../machine/', import.meta.url)));

async function run() {
  const config = loadClientConnectConfig();
  const connection = await Connection.connect(config.connectionOptions);
  const client = new Client({ connection });

  const { handle } = await startGoverned(client, { descriptor, input: { expenseId: 'my-business-id' }, taskQueue: 'expense' });

  // Prints "Done: { expenseState: 'timed_out', ... }" after approximately 10 seconds
  console.log('Done:', (await handle.result()).state);
}
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
