// node --import ./src/register.mjs src/worker.mjs [./machine | ./machine-v2]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { PolyflowPlugin, fileSink } from '@cognitive-fab/polyflow-temporal';
import { makeActivities } from './orders.mjs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

// worker
async function run() {
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE || 'saga-demo';
  const machine = fileURLToPath(new URL(process.argv[2] ?? '../machine/', import.meta.url));

  // registrations
  const activities = await makeActivities();

  // Development: `allowUncertified: true` runs the machine as it is on disk.
  // Production (G3): CI runs `polyflow admit <dir> --key ci.key.json`, the
  // worker refuses a machine whose certificate does not match its bytes, and
  // `plugin.buildId()` is the Worker Versioning build id (see README: v1 → v2).
  const trust = process.env.POLYFLOW_TRUST ? read(process.env.POLYFLOW_TRUST) : null;
  const plugin = new PolyflowPlugin({
    sink: fileSink('./ledger'),
    signingKey: process.env.POLYFLOW_KEY ? read(process.env.POLYFLOW_KEY) : undefined,
    machines: { saga: machine },
    ...(trust ? { trust } : { allowUncertified: true }),
  });

  const worker = await Worker.create({
    workflowsPath: fileURLToPath(new URL('./workflows.mjs', import.meta.url)),
    activities,
    taskQueue,
    plugins: [plugin],
    ...(trust ? { workerDeploymentOptions: { useWorkerVersioning: true, version: { deploymentName: 'saga', buildId: plugin.buildId() }, defaultVersioningBehavior: 'PINNED' } } : {}),
  });

  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
