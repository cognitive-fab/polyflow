// P6-P8 review — plans and the Jev activity on Temporal.
// Each test asserts what the spec or the module's own header claims, and fails
// today for the reason in its message. See docs/platform/reviews/P6-P8-review.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { PolyflowPlugin, memorySink, jevActivities, OBSERVE_ACTIVITY } from '../src/index.mjs';
import { parseBattery } from '@cognitive-fab/polyflow-kernel';
import { startEnv, fixtures, quiet } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const WF = `${fixtures}review-p6p8-workflows.mjs`;
const policy = (effects) => ({ policy: 'review', version: 1, effects, unlabelled: 'deny', rules: [] });

test('TP1: when a step of an admitted plan fails, no further step of that plan runs after proposePlan has returned the failure', async () => {
  const ran = [];
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'rv-tp1', workflowsPath: WF, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
    plugins: [new PolyflowPlugin({ level: 'guard', policy: policy({ boom: { kind: 'boom' }, slow: { kind: 'slow' }, after_slow: { kind: 'after_slow' } }), sink: memorySink() })],
    activities: {
      boom: async () => { throw ApplicationFailure.nonRetryable('the payment provider said no', 'Permanent'); },
      slow: async () => { await new Promise((r) => setTimeout(r, 1500)); return 'slow done'; },
      after_slow: async () => { ran.push('after_slow'); return 'ran'; },
    },
  });
  const out = await worker.runUntil(env.client.workflow.execute('failingPlanAgent', { taskQueue: 'rv-tp1', workflowId: 'rv-tp1', workflowExecutionTimeout: '60s' }));
  assert.ok(out.error, 'proposePlan reported the failure to the agent');
  assert.deepEqual(ran, [], `TP1: step 'c' of the failed plan ran ${ran.length} time(s) AFTER the agent was told the plan failed`);
});

test('TP2: a plan step and the effect that carries it out name the same arguments digest in the ledger', async () => {
  const sink = memorySink();
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'rv-tp2', workflowsPath: WF, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
    plugins: [new PolyflowPlugin({ level: 'guard', policy: policy({ slack_send: { kind: 'post', class: 'irreversible' } }), sink })],
    activities: { slack_send: async () => 'posted' },
  });
  await worker.runUntil(env.client.workflow.execute('oneStepPlan', { taskQueue: 'rv-tp2', workflowId: 'rv-tp2', workflowExecutionTimeout: '60s' }));
  const events = sink.read(sink.runs()[0]).events;
  const planned = events.find((e) => e.kind === 'proposal' && e.body.action === 'plan').body.steps[0].argsDigest;
  const done = events.find((e) => e.kind === 'effect' && e.body.activityType === 'slack_send').body.argsDigest;
  assert.equal(done, planned, 'TP2: an auditor cannot tell from the ledger that this effect is the plan\'s step');
});

test('TP3: an agent\'s 14-step plan is decided inside one workflow task without tripping the deadlock detector', async () => {
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'rv-tp3', workflowsPath: WF, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
    // Ordinary rules: a call budget and rate limits over the agent's tool (eight windows, say per tenant tier).
    plugins: [new PolyflowPlugin({ level: 'guard', policy: { ...policy({ noop: { kind: 'noop' } }), rules: [{ id: 'calls', type: 'budget', metric: 'effects', max: 1000 }, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: `rate${i}`, type: 'rate', guards: 'noop', n: 10000, perMs: 3_600_000 }))] }, sink: memorySink() })],
    activities: { noop: async () => 'ok' },
  });
  const handle = await env.client.workflow.start('wideningPlan', { taskQueue: 'rv-tp3', workflowId: 'rv-tp3', args: [{ prior: 80 }], workflowExecutionTimeout: '120s' });
  let verdict;
  let failure = null;
  await worker.runUntil(async () => {
    try {
      verdict = await Promise.race([handle.result(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60_000))]);
    } catch (err) { failure = err; }
  });
  if (failure) {
    const history = await handle.fetchHistory();
    const taskFailures = history.events.filter((e) => e.workflowTaskFailedEventAttributes).map((e) => e.workflowTaskFailedEventAttributes.failure?.message);
    await handle.terminate('review test cleanup').catch(() => {});
    assert.fail(`TP3: the run is wedged — workflow task failures: ${JSON.stringify(taskFailures.slice(0, 2))}`);
  }
  assert.equal(verdict, 'admitted');
});

test('TJ1: customer text is redacted before it is sent to Jev (polyx-jev JF0.1)', async () => {
  const sent = [];
  const battery = parseBattery({ name: 'refund', questions: { reason_stated: { type: 'noul', instructions: 'q', assertAt: 0.85, refuteAt: 0.15, calibration: { n: 120, positives: 60, negatives: 60 } } } });
  const acts = jevActivities({
    batteries: { m: { refund: battery } }, key: 'k',
    fetch: async (_url, init) => { sent.push(init.body); return { ok: true, status: 200, json: async () => ({ answers: { reason_stated: { noul: 0.9 } } }) }; },
  });
  await acts[OBSERVE_ACTIVITY]({ battery: 'refund', state: { message: 'refund me, my card is broken. password=hunter2hunter2 and api_key=sk-live-0123456789abcdefghij' } }, { machine: 'm' });
  assert.ok(!/hunter2hunter2|sk-live-0123456789abcdefghij/.test(sent[0]), 'TJ1: a credential in the message went to the vendor verbatim');
});
