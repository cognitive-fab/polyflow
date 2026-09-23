// G1 Guard — FR-GRD.1–.8 and FR-HUM.3 on ordinary agent-shaped workflows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from '@temporalio/worker';
import { verifyChain } from '@cognitive-fab/polyflow-kernel';
import { PolyflowPlugin, memorySink, FLUSH_ACTIVITY } from '../src/index.mjs';
import { startEnv, runWith, fixtures, scheduled, quiet } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const guards = fixtures + 'guard-workflows.mjs';
const activities = {
  slack_send: async ({ text }) => `posted:${text}`,
  ask_approval: async () => 'approved',
  send_email: async ({ to }) => `sent:${to}`,
  fetch_url: async ({ url }) => `page(${url})`,
  read_crm: async ({ id }) => `customer(${id})`,
};

const POLICY = {
  policy: 'customer-comms',
  version: 1,
  effects: {
    slack_send: { kind: 'post', class: 'irreversible', labels: ['egress'] },
    ask_approval: { kind: 'approval', class: 'none' },
    send_email: { kind: 'email', class: 'irreversible', labels: ['egress'] },
    fetch_url: { kind: 'fetch', class: 'none', labels: ['reads-untrusted'] },
    read_crm: { kind: 'read', class: 'none', labels: ['reads-private'] },
  },
  rules: [
    { id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' },
    { id: 'at-most-one-post', type: 'at-most', guards: 'post', n: 1 },
  ],
};

const guardPlugin = (sink, policy = POLICY) => new PolyflowPlugin({ level: 'guard', policy, sink });

test('a denied activity is never scheduled, and the denial is in the ledger', async () => {
  const sink = memorySink();
  const { result, history } = await runWith(env, {
    taskQueue: 'g1-a', workflowId: 'g1-a', workflowsPath: guards, activities,
    plugins: [guardPlugin(sink)], workflow: 'naivePoster', args: [{ text: 'hello' }],
  });
  assert.deepEqual(result.rules, ['no-post-without-approval']);
  assert.match(result.denied, /run 'approval' and wait for it to succeed before 'post'/);
  assert.ok(!scheduled(history).includes('slack_send'), 'slack_send never reached the server');
  const events = sink.read(sink.runs()[0]).events;
  const verdict = events.find((e) => e.kind === 'verdict' && e.body.outcome === 'denied');
  assert.deepEqual(verdict.body.rules, ['no-post-without-approval']);
  // At level guard an omitted `unlabelled` is enforced as 'deny' (P9 security SEC-UL1); the ledger names that policy.
  assert.equal(events[0].body.policy.digest, (await import('@cognitive-fab/polyflow-kernel')).admitPolicy({ ...POLICY, unlabelled: 'deny' }).digest);
  assert.equal(verifyChain(events).ok, true);
  // the denial had no carrier of its own: it went out on the single close flush
  assert.equal(scheduled(history).filter((t) => t === FLUSH_ACTIVITY).length, 1);
});

test('an agent that reads the witness re-plans instead of retrying the same call', async () => {
  const sink = memorySink();
  const { result } = await runWith(env, {
    taskQueue: 'g1-b', workflowId: 'g1-b', workflowsPath: guards, activities,
    plugins: [guardPlugin(sink)], workflow: 'replanningAgent', args: [{ text: 'brief' }],
  });
  assert.deepEqual(result, ['denied:no-post-without-approval', 'approved', 'posted:brief']);
});

test('the lethal trifecta escalates; a human approves that one email and it goes out', async () => {
  const policy = { ...POLICY, rules: [{ id: 'trifecta', type: 'trifecta', outcome: 'escalate' }], escalation: { role: 'approver', timeoutMs: 60_000 } };
  const sink = memorySink();
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'g1-c', workflowsPath: guards, activities,
    plugins: [guardPlugin(sink, policy)], maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
  });
  const result = await worker.runUntil(async () => {
    const h = await env.client.workflow.start('trifecta', { taskQueue: 'g1-c', workflowId: 'g1-c', args: [{ url: 'https://evil.example', to: 'x@y' }], workflowExecutionTimeout: '60s' });
    let pending = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      pending = await h.query('polyflow.pending');
      if (!pending.length) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'email');
    assert.deepEqual(pending[0].rules, ['trifecta']);
    // P5.6: the approver sees the exact arguments, and approves those.
    assert.deepEqual(pending[0].args, [{ to: 'x@y', body: 'page(https://evil.example)/customer(c-1)' }]);
    await assert.rejects(h.executeUpdate('polyflow.approve', { args: [{ approvalId: pending[0].approvalId, decision: 'approve', principal: 'alice', argsDigest: 'sha256:something-else' }] }),
      (e) => /is for arguments/.test(`${e.message} ${e.cause?.message}`));
    await h.executeUpdate('polyflow.approve', { args: [{ approvalId: pending[0].approvalId, decision: 'approve', principal: 'alice', argsDigest: pending[0].argsDigest }] });
    return h.result();
  });
  assert.equal(result, 'sent:x@y');
  const events = sink.read(sink.runs()[0]).events;
  assert.deepEqual(events.filter((e) => e.kind === 'verdict').map((e) => e.body.outcome), ['allowed', 'allowed', 'escalated', 'allowed']);
  const human = events.find((e) => e.kind === 'proposal' && e.body.source === 'human');
  assert.equal(human.body.principal.id, 'alice');
  assert.equal(human.body.principal.verified, false, 'a principal named in an Update payload is recorded as unverified');
});

test('a rejected escalation is a denial with the approver in the ledger', async () => {
  const policy = {
    ...POLICY,
    rules: [{ id: 'approve-each-email', type: 'requires-prior', guards: 'email', prior: 'approval', bind: 'per-effect' }],
    escalation: { role: 'approver', timeoutMs: 60_000 },
  };
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'g1-d', workflowsPath: guards, activities,
    plugins: [guardPlugin(memorySink(), policy)], maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
  });
  const result = await worker.runUntil(async () => {
    const h = await env.client.workflow.start('emailer', { taskQueue: 'g1-d', workflowId: 'g1-d', args: [{ emails: [{ to: 'a@x' }, { to: 'b@x' }] }], workflowExecutionTimeout: '60s' });
    const answer = async (decision) => {
      for (let i = 0; i < 100; i++) {
        const p = await h.query('polyflow.pending');
        if (p.length) return h.executeUpdate('polyflow.approve', { args: [{ approvalId: p[0].approvalId, decision, principal: 'bob' }] });
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('nothing pending');
    };
    await answer('approve');
    await answer('reject');
    return h.result();
  });
  assert.equal(result[0], 'sent:a@x');
  assert.match(result[1], /^denied:.*rejected by bob/);
});

test('an unanswered escalation times out as a denial in workflow time', async () => {
  const policy = {
    ...POLICY,
    rules: [{ id: 'approve-each-email', type: 'requires-prior', guards: 'email', prior: 'approval', bind: 'per-effect' }],
    escalation: { role: 'approver', timeoutMs: 1_500 },
  };
  const { result } = await runWith(env, {
    taskQueue: 'g1-e', workflowId: 'g1-e', workflowsPath: guards, activities,
    plugins: [guardPlugin(memorySink(), policy)], workflow: 'emailer', args: [{ emails: [{ to: 'a@x' }] }],
  });
  assert.match(result[0], /^denied:.*no decision within 1500 ms/);
});

test('guarded histories, escalations included, replay with zero non-determinism errors', async () => {
  const { history } = await runWith(env, {
    taskQueue: 'g1-f', workflowId: 'g1-f', workflowsPath: guards, activities,
    plugins: [guardPlugin(memorySink())], workflow: 'replanningAgent', args: [{ text: 'x' }],
  });
  await Worker.runReplayHistory({
    workflowsPath: guards, plugins: [guardPlugin(memorySink())], bundlerOptions: { logger: quiet }, replayName: 'g1-f',
  }, history);
});

test('a policy the kernel would refuse stops the worker from being built', () => {
  assert.throws(() => new PolyflowPlugin({ level: 'guard', policy: { ...POLICY, rules: [{ id: 'x', type: 'sometimes' }] } }), /unknown rule type 'sometimes'/);
});
