// Upstream: start `openAccount` with a generated account id and wait. The
// sample's workflow always injects a failure into addBankAccount, so its demo
// is the compensating path; `--fail-at <step>` reproduces that here (the
// default opens the account).
//
//   node src/client.mjs [--fail-at addBankAccount]
import { Client, Connection } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { startGoverned, loadMachineDir } from '@cognitive-fab/polyflow-temporal';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const { descriptor } = loadMachineDir(fileURLToPath(new URL('../machine/', import.meta.url)));

async function run() {
  const config = loadClientConnectConfig();
  const connection = await Connection.connect(config.connectionOptions);
  const client = new Client({ connection });
  const failAt = process.argv.includes('--fail-at') ? process.argv[process.argv.indexOf('--fail-at') + 1] : '';
  // workflow params: the sample's OpenAccount command
  const openAccount = {
    accountId: randomUUID(),
    address: {
      address1: '123 Temporal Street',
      postalCode: '98006',
    },
    bankDetails: {
      accountNumber: randomUUID(),
      routingNumber: '1234555',
      accountType: 'Checking',
      personalOwner: {
        firstName: 'Bart',
        lastName: 'Simpson',
      },
    },
    bankId: 'Foo Bar Savings and Loan',
    clientEmail: 'bart@simpson.io',
    failAt,
  };

  const { handle } = await startGoverned(client, { descriptor, input: openAccount, taskQueue: 'saga-demo' });
  const { state } = await handle.result();
  console.log(state.phase === 'opened' ? 'account opened' : `account not opened: ${state.phase} (${state.failedStep}: ${state.reason})`);
}

run().catch((err) => {
  console.error('account failed to open', err);
  process.exit(1);
});
