// G0 Observe — FR-LED.1, .2, .3, .7 on an unmodified agent-loop workflow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from '@temporalio/worker';
import { verifyChain } from '@cognitive-fab/polyflow-kernel';
import { PolyflowPlugin, memorySink, ledgerFromHistory, generateSigningKey, verifyHead, FLUSH_ACTIVITY } from '../src/index.mjs';
import { startEnv, runWith, fixtures, scheduled, quiet } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const key = generateSigningKey('worker-test');
const trust = { [key.keyId]: key.publicKeyPem };
const agents = fixtures + 'agent-workflows.mjs';

test('every activity the workflow schedules becomes one recorded effect, in order', async () => {
  const sink = memorySink();
  const { history, result } = await runWith(env, {
    taskQueue: 'g0-a', workflowId: 'g0-a', workflowsPath: agents,
    plugins: [new PolyflowPlugin({ sink, signingKey: key })], workflow: 'agentLoop', args: [{ steps: 3 }],
  });
  assert.equal(result.at(-1), 'posted:' + result.slice(0, -1).join(' | ').length);
  const { events, heads } = sink.read(sink.runs()[0]);
  const effects = events.filter((e) => e.kind === 'effect').map((e) => e.body.activityType);
  const work = scheduled(history).filter((t) => t !== FLUSH_ACTIVITY);
  assert.deepEqual(effects, work);
  assert.equal(events[0].kind, 'admission');
  for (const k of ['proposal', 'verdict', 'observation']) {
    assert.equal(events.filter((e) => e.kind === k).length, work.length, k);
  }
  assert.equal(verifyChain(events).ok, true);
  assert.ok(heads.length > 0 && heads.every((h) => verifyHead(h, trust).ok), 'every exported head is signed by the deployment key');
});

test('the history alone rebuilds the same ledger the sink received', async () => {
  const sink = memorySink();
  const { history } = await runWith(env, {
    taskQueue: 'g0-b', workflowId: 'g0-b', workflowsPath: agents,
    plugins: [new PolyflowPlugin({ sink })], workflow: 'agentLoop', args: [{ steps: 2 }],
  });
  const fromHistory = ledgerFromHistory(history);
  assert.deepEqual(fromHistory, sink.read(sink.runs()[0]).events);
  assert.equal(verifyChain(fromHistory).ok, true);
});

test('the trailing observation and the closure go out together on exactly one flush', async () => {
  const sink = memorySink();
  const { history } = await runWith(env, {
    taskQueue: 'g0-c', workflowId: 'g0-c', workflowsPath: agents,
    plugins: [new PolyflowPlugin({ sink })], workflow: 'agentLoop', args: [{ steps: 1 }],
  });
  assert.equal(scheduled(history).filter((t) => t === FLUSH_ACTIVITY).length, 1);
  const events = sink.read(sink.runs()[0]).events;
  assert.deepEqual(events.slice(-2).map((e) => e.kind), ['observation', 'closure'], 'the post result is recorded, then the execution is closed');
  assert.equal(events.at(-1).body.outcome, 'completed');
});

test('a failed activity is recorded as a failed observation, and the chain still verifies', async () => {
  const sink = memorySink();
  await runWith(env, {
    taskQueue: 'g0-d', workflowId: 'g0-d', workflowsPath: agents,
    plugins: [new PolyflowPlugin({ sink })], workflow: 'agentLoop', args: [{ steps: 2, failAt: 1 }],
  });
  const events = sink.read(sink.runs()[0]).events;
  const failed = events.filter((e) => e.kind === 'observation' && !e.body.ok);
  assert.equal(failed.length, 1);
  assert.match(failed[0].body.error, /upstream 503|failed/);
  assert.equal(verifyChain(events).ok, true);
});

test('Continue-as-New keeps one chain across executions', async () => {
  const sink = memorySink();
  await runWith(env, {
    taskQueue: 'g0-e', workflowId: 'g0-e', workflowsPath: agents,
    plugins: [new PolyflowPlugin({ sink })], workflow: 'longAgent', args: [{ rounds: 3 }],
  });
  const runs = sink.runs();
  assert.equal(runs.length, 1, 'one chain, keyed by the first run of the Continue-as-New chain');
  const events = sink.read(runs[0]).events;
  assert.equal(events.filter((e) => e.kind === 'admission').length, 1);
  assert.equal(events.filter((e) => e.kind === 'effect').length, 4, '3 thinks + 1 post');
  assert.equal(verifyChain(events).ok, true);
});

test('governed histories replay with zero non-determinism errors', async () => {
  const { history } = await runWith(env, {
    taskQueue: 'g0-f', workflowId: 'g0-f', workflowsPath: agents,
    plugins: [new PolyflowPlugin({ sink: memorySink() })], workflow: 'agentLoop', args: [{ steps: 3, failAt: 1 }],
  });
  await Worker.runReplayHistory({
    workflowsPath: agents, plugins: [new PolyflowPlugin({ sink: memorySink() })],
    bundlerOptions: { logger: quiet }, replayName: 'g0-f',
  }, history);
});

test('every history shape the plugin adds commands to replays clean: Continue-as-New, child, failure, signal', async () => {
  const shapes = [
    { id: 'rp-can', path: agents, workflow: 'longAgent', args: [{ rounds: 2 }] },
    { id: 'rp-child', path: `${fixtures}review-workflows.mjs`, workflow: 'parent', args: [{ failChild: true }] },
    { id: 'rp-fail', path: `${fixtures}review-workflows.mjs`, workflow: 'retried', args: [], extra: {} },
  ];
  for (const s of shapes) {
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: s.id, workflowsPath: s.path, activities: (await import('./helpers.mjs')).agentActivities,
      plugins: [new PolyflowPlugin({ sink: memorySink() })], maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
    });
    await worker.runUntil(env.client.workflow.execute(s.workflow, { taskQueue: s.id, workflowId: s.id, args: s.args, workflowExecutionTimeout: '60s' }).catch(() => null));
    // Every execution of the chain, not only the last one.
    let runId = (await env.client.workflow.getHandle(s.id).describe()).runId;
    while (runId) {
      const history = await env.client.workflow.getHandle(s.id, runId).fetchHistory();
      const started = history.events[0].workflowExecutionStartedEventAttributes;
      const previous = started.continuedExecutionRunId || null;
      await Worker.runReplayHistory({
        workflowsPath: s.path, plugins: [new PolyflowPlugin({ sink: memorySink() })], bundlerOptions: { logger: quiet }, replayName: `${s.id}-${runId}`,
      }, history, s.id); // the real workflow id: the child's id is derived from it
      runId = previous;
    }
  }
});

test('a signal is a recorded proposal', async () => {
  const sink = memorySink();
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'g0-s', workflowsPath: `${fixtures}signal-workflows.mjs`, activities: (await import('./helpers.mjs')).agentActivities,
    plugins: [new PolyflowPlugin({ sink })], maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
  });
  const history = await worker.runUntil(async () => {
    const h = await env.client.workflow.start('waitsForGo', { taskQueue: 'g0-s', workflowId: 'g0-s', workflowExecutionTimeout: '60s' });
    await h.signal('go', { note: 'now' });
    await h.result();
    return h.fetchHistory();
  });
  const events = sink.read(sink.runs()[0]).events;
  assert.ok(events.some((e) => e.kind === 'proposal' && e.body.source === 'signal' && e.body.action === 'go'));
  await Worker.runReplayHistory({ workflowsPath: `${fixtures}signal-workflows.mjs`, plugins: [new PolyflowPlugin({ sink: memorySink() })], bundlerOptions: { logger: quiet }, replayName: 'g0-s' }, history);
});

test('with memo: true, the chain head is written to the memo at close', async () => {
  const sink = memorySink();
  await runWith(env, {
    taskQueue: 'g0-g', workflowId: 'g0-g', workflowsPath: agents,
    plugins: [new PolyflowPlugin({ sink, memo: true })], workflow: 'agentLoop', args: [{ steps: 1 }],
  });
  const desc = await env.client.workflow.getHandle('g0-g').describe();
  const events = sink.read(sink.runs()[0]).events;
  assert.deepEqual(desc.memo.polyflow.head, { seq: events.at(-1).seq, hash: events.at(-1).hash });
});
