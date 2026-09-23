// FR-OBS.1 — span attributes for a customer's tracer, from the verified ledger
// delta (never from workflow code, which replays).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PolyflowPlugin, memorySink, spanAttributes } from '../src/index.mjs';
import { startEnv, runWith, fixtures } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

test('every governed effect and every refusal becomes a span with its verdict, rules and ledger position', async () => {
  const spans = [];
  const policy = {
    policy: 'comms', version: 1,
    effects: { slack_send: { kind: 'post', class: 'irreversible', labels: ['egress'] }, ask_approval: { kind: 'approval', class: 'none' } },
    rules: [{ id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' }],
  };
  await runWith(env, {
    taskQueue: 'otel-a', workflowId: 'otel-a', workflowsPath: `${fixtures}guard-workflows.mjs`, workflow: 'replanningAgent', args: [{ text: 'x' }],
    activities: { slack_send: async () => 'posted', ask_approval: async () => 'yes' },
    plugins: [new PolyflowPlugin({ level: 'guard', policy, sink: memorySink(), onEvents: (events) => spans.push(...spanAttributes(events)) })],
  });
  const denied = spans.find((s) => s.name === 'polyflow denied');
  assert.equal(denied.attributes['polyflow.rules'], 'no-post-without-approval');
  const post = spans.find((s) => s.name === 'polyflow slack_send');
  assert.equal(post.attributes['polyflow.verdict'], 'allowed');
  assert.equal(post.attributes['polyflow.effect.class'], 'irreversible');
  assert.match(post.attributes['polyflow.ledger.hash'], /^sha256:/);
});
