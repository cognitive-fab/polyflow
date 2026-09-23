import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';

export const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Warnings and errors only: webpack and worker INFO lines drown test output. */
export const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error: (...a) => console.error(...a), log() {} };

export const agentActivities = {
  think: async ({ i }) => `thought-${i}`,
  search: async ({ q }) => `found(${q})`,
  flaky: async () => { throw new Error('upstream 503'); },
  post: async ({ text }) => `posted:${text.length}`,
};

export async function startEnv() {
  return TestWorkflowEnvironment.createLocal();
}

/** Run a workflow to completion with a fresh worker; a stuck workflow task fails the test instead of hanging it. */
export async function runWith(env, { taskQueue, workflowsPath, plugins = [], activities = agentActivities, workflow, args = [], workflowId, extra = {} }) {
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue, workflowsPath, activities, plugins,
    maxCachedWorkflows: 0, bundlerOptions: { logger: quiet }, ...extra,
  });
  const result = await worker.runUntil(env.client.workflow.execute(workflow, {
    taskQueue, workflowId, args, workflowExecutionTimeout: '60s',
  }));
  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  return { result, history };
}

/** Activity types scheduled in a history, in order. */
export const scheduled = (history) => history.events
  .map((e) => e.activityTaskScheduledEventAttributes?.activityType?.name)
  .filter(Boolean);
