// Adversarial review (P0/P1) against a real Temporal dev server.
// Each test failed against the P1 code and is kept as a regression test; see
// docs/platform/reviews/P0-P1-review.md. Run alone:
//   node --no-warnings --test --test-concurrency=1 test/review-temporal.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { verifyChain } from '@cognitive-fab/polyflow-kernel';
import { PolyflowPlugin, memorySink, ledgerFromHistory, FLUSH_ACTIVITY } from '../src/index.mjs';
import { startEnv, runWith, fixtures, scheduled, quiet, agentActivities } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const wfs = fixtures + 'review-workflows.mjs';
const T = { timeout: 90_000 };

/** A second plugin that replaces the flush activity — models flush latency or a flush that cannot run. */
const flushOverride = (impl) => ({
  name: 'review-flush-override',
  configureWorker: (o) => ({ ...o, activities: { ...(o.activities ?? {}), [FLUSH_ACTIVITY]: impl } }),
});

// T1 / finding L1: the chain is keyed by firstExecutionRunId, which Temporal
// keeps across workflow RETRIES (and cron runs). The retry starts a second
// chain at seq 0 under the same key: the sink reports conflicts and the
// exported ledger no longer verifies.
test('review T1: a workflow retry does not fork the chain it shares a key with', T, async () => {
  const sink = memorySink();
  const conflicts = [];
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'rv-t1', workflowsPath: wfs, activities: agentActivities,
    plugins: [new PolyflowPlugin({ sink, onConflict: (_r, s) => conflicts.push(...s) })],
    maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
  });
  await worker.runUntil(env.client.workflow.execute('retried', {
    taskQueue: 'rv-t1', workflowId: 'rv-t1', workflowExecutionTimeout: '60s',
    retry: { maximumAttempts: 2, initialInterval: '100ms' },
  }));
  const events = sink.read(sink.runs()[0]).events;
  assert.deepEqual(conflicts, [], 'the sink saw two different events at the same (run, seq)');
  assert.equal(verifyChain(events).ok, true, JSON.stringify(verifyChain(events)));
});

// T2 / finding D1: on a NON-Temporal error (a TypeError — a workflow TASK
// failure the operator is supposed to fix by redeploying), the execute wrapper
// still schedules the close flush. That commits a polyflow.flush command to
// history for a workflow that is still running, so the fixed code no longer
// replays: the plugin turns a recoverable bug into a non-determinism error.
test('review T2: a workflow-task failure stays fixable by redeploy under the plugin', T, async () => {
  async function scenario(id, plugins) {
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: id, workflowsPath: fixtures + 'review-buggy.mjs', activities: agentActivities,
      plugins, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
    });
    const handle = await env.client.workflow.start('evolving', { taskQueue: id, workflowId: id, workflowExecutionTimeout: '60s' });
    await worker.runUntil(async () => {
      for (let i = 0; i < 100; i++) {
        const h = await handle.fetchHistory();
        if (h.events.some((e) => e.workflowTaskFailedEventAttributes)) return;
        await delay(200);
      }
      throw new Error('no workflow task failure observed');
    });
    const history = await handle.fetchHistory();
    await handle.terminate('review done');
    return history;
  }
  // Control: without the plugin, deploying the fix replays cleanly.
  const plain = await scenario('rv-t2-plain', []);
  await Worker.runReplayHistory({ workflowsPath: fixtures + 'review-fixed.mjs', bundlerOptions: { logger: quiet }, replayName: 'plain' }, plain);

  const governed = await scenario('rv-t2-gov', [new PolyflowPlugin({ sink: memorySink() })]);
  const flushes = scheduled(governed).filter((t) => t === FLUSH_ACTIVITY);
  let replayError = null;
  try {
    await Worker.runReplayHistory({
      workflowsPath: fixtures + 'review-fixed.mjs', plugins: [new PolyflowPlugin({ sink: memorySink() })],
      bundlerOptions: { logger: quiet }, replayName: 'governed',
    }, governed);
  } catch (err) { replayError = err; }
  assert.equal(replayError, null, `deploying the fix now fails replay: ${replayError?.name}: ${replayError?.message} (flushes in history: ${flushes.length})`);
});

// T3 / finding D2: a flush that fails changes the workflow's OUTCOME. The
// workflow's own code succeeded; the plugin turns it into a failure (and on
// the error path, replaces the workflow's real error with the flush's).
test('review T3: a failing close flush never changes the workflow result', T, async () => {
  const { result } = await runWith(env, {
    taskQueue: 'rv-t3', workflowId: 'rv-t3', workflowsPath: fixtures + 'agent-workflows.mjs', workflow: 'agentLoop', args: [{ steps: 1 }],
    plugins: [new PolyflowPlugin({ sink: memorySink() }), flushOverride(async () => { throw ApplicationFailure.nonRetryable('sink worker not deployed'); })],
  }).catch((err) => ({ result: err }));
  assert.ok(Array.isArray(result), `workflow outcome replaced by the flush failure: ${result?.cause?.message ?? result}`);
});

// T4 / finding L2: events carried on a child-workflow start header are in the
// parent's history but never reach the sink (only activity headers are
// exported), so the sink's copy of the ledger has a gap and does not verify.
test('review T4: the sink receives every event a child-workflow start carried', T, async () => {
  const sink = memorySink();
  const { history } = await runWith(env, {
    taskQueue: 'rv-t4', workflowId: 'rv-t4', workflowsPath: wfs, workflow: 'parent', args: [{}],
    plugins: [new PolyflowPlugin({ sink })],
  });
  const run = sink.runs().find((r) => r.wf === 'rv-t4');
  const fromSink = sink.read(run).events;
  const fromHistory = ledgerFromHistory(history);
  assert.equal(verifyChain(fromHistory).ok, true);
  assert.equal(verifyChain(fromSink).ok, true, `sink copy: ${JSON.stringify(verifyChain(fromSink))}`);
});

// T4b / finding L3: startChildWorkflowExecution's next() resolves at SCHEDULE
// time to [startPromise, completePromise], so the observation is appended
// immediately, ok:true, with a digest of two empty objects — even for a child
// that fails.
test('review T4b: a failed child workflow is observed as failed', T, async () => {
  const sink = memorySink();
  await runWith(env, {
    taskQueue: 'rv-t4b', workflowId: 'rv-t4b', workflowsPath: wfs, workflow: 'parent', args: [{ failChild: true }],
    plugins: [new PolyflowPlugin({ sink })],
  });
  const all = ledgerFromHistory(await env.client.workflow.getHandle('rv-t4b').fetchHistory());
  const childEffect = all.find((e) => e.kind === 'effect' && e.body.via === 'child-workflow');
  const obs = all.find((e) => e.kind === 'observation' && e.body.effect === childEffect?.body.id);
  assert.ok(obs, 'child observation present');
  assert.equal(obs.body.ok, false, `failed child recorded as ${JSON.stringify(obs.body)}`);
});

// T5 / finding L4: an observation appended while the close flush is in flight
// (an activity that was still running when the workflow returned) is appended
// after the flush drained the buffer. It has no carrier, yet the memo head
// points at it: the exported ledger ends one event short of the memo head.
test('review T5: nothing is appended after the final carrier', T, async () => {
  const sink = memorySink();
  const acts = { ...agentActivities, search: async ({ q }) => { await delay(500); return `found(${q})`; } };
  const { history } = await runWith(env, {
    taskQueue: 'rv-t5', workflowId: 'rv-t5', workflowsPath: wfs, workflow: 'detachedNoAwait', activities: acts,
    plugins: [new PolyflowPlugin({ sink, memo: true }), flushOverride(async () => { await delay(2000); return { flushed: true }; })],
  });
  const events = ledgerFromHistory(history);
  const desc = await env.client.workflow.getHandle('rv-t5').describe();
  assert.deepEqual(desc.memo.polyflow.head, { seq: events.at(-1).seq, hash: events.at(-1).hash },
    `memo head seq ${desc.memo.polyflow.head.seq} but the history/sink ledger ends at seq ${events.at(-1).seq}`);
});

// T6 / finding P1: a bundle built with plugin.bundlerOptions() and loaded the
// standard production way ({ codePath }) is refused, because MARK is only
// looked for in `workflowBundle.code`.
test('review T6: a pre-built bundle passed as { codePath } is accepted', T, async () => {
  const plugin = new PolyflowPlugin({ sink: memorySink() });
  const { code } = await bundleWorkflowCode(plugin.bundlerOptions({ workflowsPath: fixtures + 'agent-workflows.mjs', logger: quiet }));
  const codePath = join(mkdtempSync(join(tmpdir(), 'rv-t6-')), 'bundle.js');
  writeFileSync(codePath, code);
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'rv-t6', workflowBundle: { codePath }, activities: agentActivities, plugins: [plugin],
  });
  await worker.runUntil(Promise.resolve());
  // ...and a bundle built for a DIFFERENT configuration is refused.
  const other = new PolyflowPlugin({ level: 'guard', sink: memorySink(), policy: { policy: 'p', version: 1, effects: { think: { kind: 'think' } } } });
  await assert.rejects(Worker.create({
    connection: env.nativeConnection, taskQueue: 'rv-t6b', workflowBundle: { codePath }, activities: agentActivities, plugins: [other],
  }), /not built with this PolyflowPlugin configuration/);
});

// T7 / finding L5: effect idempotency keys are `${wf}/${firstExecutionRunId}/${kind}/${input.seq}`,
// but input.seq restarts in every Continue-as-New execution while the run key
// does not, so different effects in one chain share an "idempotency" key.
test('review T7: idempotency keys are unique across a Continue-as-New chain', T, async () => {
  const sink = memorySink();
  await runWith(env, {
    taskQueue: 'rv-t7', workflowId: 'rv-t7', workflowsPath: fixtures + 'agent-workflows.mjs', workflow: 'longAgent', args: [{ rounds: 3 }],
    plugins: [new PolyflowPlugin({ sink })],
  });
  const keys = sink.read(sink.runs()[0]).events.filter((e) => e.kind === 'effect').map((e) => e.body.idempotencyKey);
  assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys.join(', ')}`);
});
