// Spike P0.4 / review O1: the guard must be the innermost workflow interceptor,
// or a module registered after it could rewrite an input it already decided.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from '@temporalio/worker';
import { PolyflowPlugin, memorySink } from '../src/index.mjs';
import { argsDigest } from '../src/workflow-interceptors.mjs';
import { startEnv, runWith, fixtures, quiet, agentActivities } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const mutating = {
  name: 'mutating',
  configureWorker: (o) => ({
    ...o,
    interceptors: { ...(o.interceptors ?? {}), workflowModules: [...(o.interceptors?.workflowModules ?? []), `${fixtures}mutating-interceptors.mjs`] },
  }),
};

test('listed last, the plugin records the input as the other plugins left it', async () => {
  const sink = memorySink();
  const seen = [];
  await runWith(env, {
    taskQueue: 'ord-a', workflowId: 'ord-a', workflowsPath: `${fixtures}agent-workflows.mjs`, workflow: 'agentLoop', args: [{ steps: 1 }],
    plugins: [mutating, new PolyflowPlugin({ sink })],
    activities: { ...agentActivities, think: async (a) => { seen.push(a); return 'ok'; } },
  });
  const effect = sink.read(sink.runs()[0]).events.find((e) => e.kind === 'effect' && e.body.activityType === 'think');
  assert.equal(seen[0].rewritten, true);
  assert.equal(effect.body.argsDigest, argsDigest([seen[0]]), 'the recorded digest is of what actually ran');
});

test('a workflow interceptor module registered after the plugin stops the worker', async () => {
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'ord-b', workflowsPath: `${fixtures}agent-workflows.mjs`,
    activities: agentActivities, plugins: [new PolyflowPlugin({ sink: memorySink() }), mutating], bundlerOptions: { logger: quiet },
  });
  await assert.rejects(worker.run(), /PolyflowPlugin must be the last workflow interceptor module/);
});
