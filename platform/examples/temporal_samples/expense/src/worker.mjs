import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { PolyflowPlugin, fileSink } from '@cognitive-fab/polyflow-temporal';
import * as activities from './orders.mjs';

const MACHINE = fileURLToPath(new URL('../machine/', import.meta.url));
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

async function run() {
  // Development: `allowUncertified: true` runs the machine as it is on disk.
  // Production (G3): CI runs `polyflow admit ./machine --key ci.key.json` and
  // the worker refuses a machine whose certificate does not match its bytes.
  const trust = process.env.POLYFLOW_TRUST ? read(process.env.POLYFLOW_TRUST) : null;
  const worker = await Worker.create({
    workflowsPath: fileURLToPath(new URL('./workflows.mjs', import.meta.url)),
    activities,
    taskQueue: 'expense',
    plugins: [new PolyflowPlugin({
      sink: fileSink('./ledger'),
      signingKey: process.env.POLYFLOW_KEY ? read(process.env.POLYFLOW_KEY) : undefined,
      machines: { expense: MACHINE },
      ...(trust ? { trust } : { allowUncertified: true }),
    })],
  });

  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
