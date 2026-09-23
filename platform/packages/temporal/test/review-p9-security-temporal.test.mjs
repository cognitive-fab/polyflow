// P9 security review — trust boundaries on a real (local, time-skipping-free)
// Temporal dev server. Each test asserts what an operator who configured
// verified principals (plugin `principals`, P5.5) is entitled to expect, and
// fails today for the reason in its message.
// See docs/platform/reviews/P9-security-review.md (ids in the titles).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { defaultPayloadConverter } from '@temporalio/common';
import { digest } from '@cognitive-fab/polyflow-kernel';
import { PolyflowPlugin, memorySink, generateSigningKey, signPrincipal } from '../src/index.mjs';
import { startEnv, fixtures, quiet } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const idp = generateSigningKey('idp');
const principals = { [idp.keyId]: idp.publicKeyPem };
const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (e) => `${e?.message} ${e?.cause?.message ?? ''}`;

test('SEC-MG1: with verified principals configured, polyflow.migrate is refused from a caller who presents none', async () => {
  let posted = 0;
  const releases = [];
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'p9-mg1', workflowsPath: `${fixtures}governed-workflows.mjs`, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
    activities: {
      fetch_tickets: async () => ({ count: 3 }),
      draft_brief: async () => ({}),
      request_approval: () => new Promise((r) => releases.push(r)), // the human has not decided
      post_brief: async () => { posted++; return {}; },
    },
    plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF }, allowUncertified: true, principals })],
  });
  await worker.runUntil(async () => {
    const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'p9-mg1', workflowId: 'p9-mg1', args: [{ machine: 'customer-brief', input: {} }], workflowExecutionTimeout: '60s' });
    let s;
    for (let i = 0; i < 200; i++) { s = await h.query('polyflow.state'); if (s.state.briefState === 'review') break; await pause(50); }
    assert.equal(s.state.briefState, 'review', 'setup: the run waits for the human approval');
    // Anyone with Update access to the namespace: no principal, a state read
    // from the public query, and a terminal target the release path would refuse without `force`.
    let refused = null;
    try {
      await h.executeUpdate('polyflow.migrate', { args: [{ snapshot: { ...s.state, briefState: 'posted' }, from: digest(s.state) }] });
    } catch (err) { refused = err; }
    let outcome = null;
    try {
      if (!refused) {
        // The continued run re-issues the approval order; let it settle so the run can close.
        for (let i = 0; i < 200 && releases.length < 2; i++) await pause(50);
        releases.forEach((r) => r({}));
        outcome = await env.client.workflow.getHandle('p9-mg1').result().catch((e) => ({ error: e.message }));
      } else {
        await h.terminate('p9 cleanup').catch(() => {});
      }
    } finally {
      releases.forEach((r) => r({})); // never leave an activity pending: worker shutdown waits for it
    }
    assert.ok(refused, `SEC-MG1: an unauthenticated polyflow.migrate was accepted. The run continued as new inside '${outcome?.state?.briefState}' and ended there: post_brief ran ${posted} time(s) and no approver ever decided. migrate checks no principal (release requires 'operator'), and accepts a terminal snapshot (release requires force)`);
    assert.match(msg(refused), /principal|operator/, 'SEC-MG1: refused, but not for want of an authorised principal');
  });
});

const POLICY = {
  policy: 'p9', version: 1,
  effects: {
    send_email: { kind: 'email', class: 'irreversible', labels: ['egress'] },
    fetch_url: { kind: 'fetch', class: 'none', labels: ['reads-untrusted'] },
    read_crm: { kind: 'read', class: 'none', labels: ['reads-private'] },
  },
  rules: [{ id: 'trifecta', type: 'trifecta', outcome: 'escalate' }],
  escalation: { role: 'approver', timeoutMs: 60_000 },
};

test('SEC-PR1: an approver token lifted from one run\'s history does not approve an escalation in another run', async () => {
  const sent = [];
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'p9-pr1', workflowsPath: `${fixtures}guard-workflows.mjs`, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
    activities: { send_email: async ({ to }) => { sent.push(to); return `sent:${to}`; }, fetch_url: async () => 'page', read_crm: async () => 'customer' },
    plugins: [new PolyflowPlugin({ level: 'guard', policy: POLICY, sink: memorySink(), principals })],
  });
  await worker.runUntil(async () => {
    const start = (id, to) => env.client.workflow.start('trifecta', { taskQueue: 'p9-pr1', workflowId: id, args: [{ url: 'https://x', to }], workflowExecutionTimeout: '60s' });
    const pendingOf = async (h) => {
      for (let i = 0; i < 100; i++) { const p = await h.query('polyflow.pending'); if (p.length) return p[0]; await pause(100); }
      throw new Error('no escalation');
    };
    // Run A: alice, a real approver, approves the one email she was shown.
    const a = await start('p9-pr1-a', 'partner@example.com');
    const pa = await pendingOf(a);
    // (Response: tokens are now minted for one action, as the finding's fix asks.)
    const act = { op: 'approve', wf: 'p9-pr1-a', run: a.firstExecutionRunId, ref: pa.approvalId, decision: 'approve', argsDigest: pa.argsDigest };
    await a.executeUpdate('polyflow.approve', { args: [{ approvalId: pa.approvalId, decision: 'approve', principal: signPrincipal({ id: 'alice', roles: ['approver'], aud: 'default', act }, idp) }] });
    await a.result();
    // Anyone who can READ run A's history (a UI viewer, an export) finds her token in the accepted Update.
    const history = await a.fetchHistory();
    const accepted = history.events.find((e) => e.workflowExecutionUpdateAcceptedEventAttributes);
    const lifted = defaultPayloadConverter.fromPayload(accepted.workflowExecutionUpdateAcceptedEventAttributes.acceptedRequest.input.args.payloads[0]).principal;
    assert.equal(lifted?.body?.id, 'alice', 'setup: the bearer token is in history');
    // Run B: an exfiltration the approver never saw, approved with her lifted token.
    const b = await start('p9-pr1-b', 'attacker@evil.example');
    const pb = await pendingOf(b);
    let refused = null;
    try {
      await b.executeUpdate('polyflow.approve', { args: [{ approvalId: pb.approvalId, decision: 'approve', principal: lifted }] });
    } catch (err) { refused = err; }
    if (refused) await b.terminate('p9 cleanup').catch(() => {}); else await b.result();
    assert.ok(refused, `SEC-PR1: alice's token, read from run A's history, approved run B's escalation; emails sent: ${sent.join(', ')}. A principal token is a bearer identity, stored in history, reusable for every Update in the namespace until exp`);
  });
});
