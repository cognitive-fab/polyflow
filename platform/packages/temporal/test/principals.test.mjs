// P5.5 — verified principals. With a trust store, who approves, reports or
// claims is a signed token the WORKFLOW verifies (pure-JS ed25519 in the
// isolate): a bare name, a token from an untrusted key, an expired token, or
// one without the role is refused before it enters history.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { verifyPrincipal, digest } from '@cognitive-fab/polyflow-kernel';
import { PolyflowPlugin, memorySink, generateSigningKey, signPrincipal } from '../src/index.mjs';
import { startEnv, fixtures, quiet } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const idp = generateSigningKey('idp');
const rogue = generateSigningKey('idp'); // same key id, different key
const principals = { [idp.keyId]: idp.publicKeyPem };
const msg = (e) => `${e?.message} ${e?.cause?.message ?? ''}`;

test('the kernel verifies a token node:crypto signed, and nothing else', () => {
  const now = 1_000_000;
  const t = signPrincipal({ id: 'alice', roles: ['approver'], aud: 'default' }, idp, { now });
  assert.deepEqual(verifyPrincipal(t, { trust: principals, now, audience: 'default' }).principal, { id: 'alice', roles: ['approver'], verified: true, keyId: 'idp' });
  // Bound to one action (P9 SEC-PR1): a token for one approval does not cover another.
  const bound = signPrincipal({ id: 'alice', roles: ['approver'], aud: 'default', act: { op: 'approve', wf: 'w', run: 'r', ref: 'ap-p3', decision: 'approve', argsDigest: 'sha256:a' } }, idp, { now });
  assert.equal(verifyPrincipal(bound, { trust: principals, now, action: { op: 'approve', wf: 'w', run: 'r', ref: 'ap-p3', decision: 'approve', argsDigest: 'sha256:a' } }).ok, true);
  assert.match(verifyPrincipal(bound, { trust: principals, now, action: { op: 'approve', wf: 'w', run: 'r2', ref: 'ap-p3', decision: 'approve', argsDigest: 'sha256:a' } }).reason, /another action/);
  assert.match(verifyPrincipal(signPrincipal({ id: 'a', aud: 'default' }, idp, { now, ttlMs: 3_600_000 }), { trust: principals, now }).reason, /at most/, 'lifetime is bounded');
  assert.match(verifyPrincipal(signPrincipal({ id: 'alice', aud: 'default' }, rogue, { now }), { trust: principals, now }).reason, /does not verify/);
  assert.match(verifyPrincipal({ ...t, body: { ...t.body, roles: ['admin'] } }, { trust: principals, now }).reason, /does not verify/, 'an edited role breaks the signature');
  assert.match(verifyPrincipal(t, { trust: principals, now: now + 16 * 60_000 }).reason, /expired/);
  assert.match(verifyPrincipal(t, { trust: principals, now, audience: 'prod' }).reason, /not 'prod'/);
  assert.match(verifyPrincipal({ id: 'alice' }, { trust: principals, now }).reason, /bare claim/);
});

const POLICY = {
  policy: 'p55', version: 1,
  effects: {
    send_email: { kind: 'email', class: 'irreversible', labels: ['egress'] },
    fetch_url: { kind: 'fetch', class: 'none', labels: ['reads-untrusted'] },
    read_crm: { kind: 'read', class: 'none', labels: ['reads-private'] },
  },
  rules: [{ id: 'trifecta', type: 'trifecta', outcome: 'escalate' }],
  escalation: { role: 'approver', timeoutMs: 60_000 },
};

test('an escalation is decided only by a verified principal holding the escalation role', async () => {
  const sink = memorySink();
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'p55-a', workflowsPath: `${fixtures}guard-workflows.mjs`, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
    activities: { send_email: async ({ to }) => `sent:${to}`, fetch_url: async () => 'page', read_crm: async () => 'customer' },
    plugins: [new PolyflowPlugin({ level: 'guard', policy: POLICY, sink, principals })],
  });
  const result = await worker.runUntil(async () => {
    const h = await env.client.workflow.start('trifecta', { taskQueue: 'p55-a', workflowId: 'p55-a', args: [{ url: 'https://x', to: 'x@y' }], workflowExecutionTimeout: '60s' });
    let pending = [];
    for (let i = 0; i < 100 && !pending.length; i++) { pending = await h.query('polyflow.pending'); if (!pending.length) await new Promise((r) => setTimeout(r, 100)); }
    const { approvalId, argsDigest } = pending[0];
    const act = { op: 'approve', wf: 'p55-a', run: h.firstExecutionRunId, ref: approvalId, decision: 'approve', argsDigest };
    const approve = (principal) => h.executeUpdate('polyflow.approve', { args: [{ approvalId, decision: 'approve', principal }] });
    await assert.rejects(approve('alice'), (e) => /bare claim/.test(msg(e)), 'a name is not an identity');
    await assert.rejects(approve(signPrincipal({ id: 'mallory', roles: ['approver'], aud: 'default', act }, rogue)), (e) => /does not verify/.test(msg(e)));
    await assert.rejects(approve(signPrincipal({ id: 'bob', roles: ['agent'], aud: 'default', act }, idp)), (e) => /decided by role 'approver'/.test(msg(e)));
    await assert.rejects(approve(signPrincipal({ id: 'alice', roles: ['approver'], aud: 'default', act: { ...act, decision: 'reject' } }, idp)), (e) => /another action/.test(msg(e)), 'signed for another decision');
    await approve(signPrincipal({ id: 'alice', roles: ['approver'], aud: 'default', act }, idp));
    return h.result();
  });
  assert.equal(result, 'sent:x@y');
  const human = sink.read(sink.runs()[0]).events.find((e) => e.kind === 'proposal' && e.body.source === 'human');
  assert.deepEqual(human.body.principal, { id: 'alice', roles: ['approver'], verified: true, keyId: 'idp' });
});

test('a governed order addressed to a person is reported only by a verified holder of that role', async () => {
  const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'p55-b', workflowsPath: `${fixtures}governed-workflows.mjs`, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
    activities: {},
    plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF }, allowUncertified: true, externalMode: 'always', principals })],
  });
  await worker.runUntil(async () => {
    const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'p55-b', workflowId: 'p55-b', args: [{ machine: 'customer-brief', input: {} }], workflowExecutionTimeout: '60s' });
    // A report token is bound to the order, its attempt and the outcome reported (P9 review PR1).
    const agent = (o, outcome) => signPrincipal({ id: 'agent-7', roles: ['agent'], aud: 'default', act: { op: 'report', wf: 'p55-b', ref: o.orderId, attempt: o.attempt, digest: digest({ ok: true, error: '', permanent: false, ...outcome }) } }, idp);
    const nextOrder = async () => {
      for (let i = 0; i < 100; i++) { const s = await h.query('polyflow.state'); if (s.orders.length) return s.orders[0]; await new Promise((r) => setTimeout(r, 50)); }
      throw new Error('no order');
    };
    let o = await nextOrder();
    await assert.rejects(h.executeUpdate('polyflow.report', { args: [{ orderId: o.orderId, ok: true, result: { count: 2 }, actor: { id: 'agent-7', roles: ['agent'] } }] }), (e) => /bare claim/.test(msg(e)));
    await assert.rejects(h.executeUpdate('polyflow.report', { args: [{ orderId: o.orderId, ok: true, result: { count: 2 }, actor: agent({ ...o, orderId: 'some-other-order' }, { result: { count: 2 } }) }] }), (e) => /another action/.test(msg(e)));
    await h.executeUpdate('polyflow.report', { args: [{ orderId: o.orderId, ok: true, result: { count: 2 }, actor: agent(o, { result: { count: 2 } }) }] });
    o = await nextOrder();
    await h.executeUpdate('polyflow.report', { args: [{ orderId: o.orderId, ok: true, result: {}, actor: agent(o, { result: {} }) }] });
    o = await nextOrder(); // the approval, addressed to a person
    assert.equal(o.role, 'human');
    await assert.rejects(h.executeUpdate('polyflow.report', { args: [{ orderId: o.orderId, ok: true, result: {}, actor: agent(o, { result: {} }) }] }), (e) => /addressed to role 'human'/.test(msg(e)));
    const claim = await h.executeUpdate('polyflow.claim', { args: [{ orderId: o.orderId, actor: signPrincipal({ id: 'dana', roles: ['human'], aud: 'default', act: { op: 'claim', wf: 'p55-b', ref: o.orderId } }, idp) }] });
    assert.equal(claim.holder, 'dana');
    const journal = await h.query('polyflow.journal');
    assert.deepEqual(journal.find((j) => j.action === 'polyflow.claim').data.actor, { id: 'dana', verified: true });
    await h.terminate('done');
  });
});
