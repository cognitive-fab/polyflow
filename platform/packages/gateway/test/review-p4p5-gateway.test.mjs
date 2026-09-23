// Review P4/P5 — the gateway. Fails today; see
// docs/platform/reviews/P4-P5-review.md, finding GW1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { PolyflowPlugin, memorySink } from '@cognitive-fab/polyflow-temporal';
import { createGateway } from '../src/index.mjs';

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const WORKFLOWS = fileURLToPath(new URL('../../temporal/test/fixtures/governed-workflows.mjs', import.meta.url));
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error: (...a) => console.error(...a), log() {} };

let env;
let worker;
let running;
before(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'rv45-gw', workflowsPath: WORKFLOWS, activities: {}, maxCachedWorkflows: 0,
    bundlerOptions: { logger: quiet },
    plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF }, allowUncertified: true, externalMode: 'always' })],
  });
  running = worker.run();
});
after(async () => {
  worker?.shutdown();
  await running?.catch(() => {});
  await env?.teardown();
});

// GW1 (minor) — a retryable failure report journals a 'retry' row at the SAME
// seq (the workflow does not step), and TemporalPolyflow.settle only returns
// early once `seq > sinceSeq`. So workflow_report with ok:false waits out the
// full 10 s settle timeout every time — exactly the stall the root makeTools
// comment says it avoids — and the view it returns carries no sign it timed out.
test('GW1: a retryable failure report answers promptly with the re-offered order', async () => {
  const { tools } = createGateway({ client: env.client, taskQueue: 'rv45-gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true });
  const call = (n, a = {}) => tools.find((t) => t.name === n).handler(a);
  const v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2032-01-01' } });
  try {
    const t0 = Date.now();
    const r = await call('workflow_report', { order_id: v.next[0].order_id, ok: false, error: 'upstream 503' });
    const ms = Date.now() - t0;
    assert.equal(r.next?.[0]?.attempt, 2, JSON.stringify(r));
    assert.ok(ms < 5000, `a retry report took ${ms} ms to answer`);
  } finally {
    await env.client.workflow.getHandle(v.instance).terminate('review cleanup').catch(() => {});
  }
});
