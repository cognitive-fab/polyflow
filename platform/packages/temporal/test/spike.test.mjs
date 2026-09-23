// P0 spikes, kept as tests: each one is an assumption the design rests on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
let env;
before(async () => { env = await TestWorkflowEnvironment.createLocal(); });
after(async () => { await env?.teardown(); });

const HAPPY = [['START', {}], ['TICKETS_READY', { count: 3 }], ['DRAFT_READY', {}], ['APPROVED', {}], ['POST_DONE', {}]];

test('P0.2: a SAM v2 strict machine steps inside the workflow isolate and replays clean', async () => {
  const bundle = await bundleWorkflowCode({ workflowsPath: fixtures + 'spike-workflows.mjs', logger: quiet });
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'p02', workflowBundle: bundle,
    activities: { echo: async (x) => x }, maxCachedWorkflows: 0, // every task replays from history
  });
  const out = await worker.runUntil(env.client.workflow.execute('machineSpike', {
    taskQueue: 'p02', workflowId: 'p02-happy', args: [HAPPY], workflowExecutionTimeout: '60s',
  }));
  assert.equal(out.state.briefState, 'posted');
  assert.deepEqual(out.kinds, ['fetch_tickets', 'draft_brief', 'request_approval', 'post_brief']);

  const history = await env.client.workflow.getHandle('p02-happy').fetchHistory();
  await Worker.runReplayHistory({ workflowBundle: bundle, replayName: 'p02' }, history);
});

const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error: console.error, log() {} };
