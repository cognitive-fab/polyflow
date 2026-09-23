// P9 review — Temporal-level findings (hand-over, frozen approvals, action-bound
// tokens, replay under key changes). Each test asserts what the plan, the P9
// security Response or the acquisition brief claims, and fails today for the
// reason in its message. See docs/platform/reviews/P9-review.md.
//
// Needs the local dev server (TestWorkflowEnvironment.createLocal). Every run
// started here is terminated or completes; no activity is left parked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Worker } from '@temporalio/worker';
import { digest } from '@cognitive-fab/polyflow-kernel';
import { PolyflowPlugin, memorySink, generateSigningKey, signPrincipal } from '../src/index.mjs';
import { startEnv, fixtures, quiet, runWith } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const idp = generateSigningKey('idp');
const principals = { [idp.keyId]: idp.publicKeyPem };
const msg = (e) => `${e?.message} ${e?.cause?.message ?? ''}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The first argument of every accepted Update of this name, as history stores it (what a history reader sees). */
async function acceptedUpdateArgs(handle, name) {
  const history = await handle.fetchHistory();
  return history.events
    .map((e) => e.workflowExecutionUpdateAcceptedEventAttributes?.acceptedRequest?.input)
    .filter((i) => i?.name === name)
    .map((i) => JSON.parse(Buffer.from(i.args.payloads[0].data).toString('utf-8')));
}

async function until(fn, what, n = 100) {
  for (let i = 0; i < n; i++) { let v = null; try { v = await fn(); } catch { v = null; } if (v) return v; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}

const governedWorker = (taskQueue, extra = {}) => Worker.create({
  connection: env.nativeConnection, taskQueue, workflowsPath: `${fixtures}governed-workflows.mjs`, activities: {}, maxCachedWorkflows: 0,
  bundlerOptions: { logger: quiet },
  plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF }, allowUncertified: true, externalMode: 'always', onConflict: () => {}, onError: () => {}, ...extra })],
});

test('HO1: an Update the run accepts while it hands over (Continue-as-New) is not lost', async () => {
  const worker = await governedWorker('rv9-ho1');
  await worker.runUntil(async () => {
    const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'rv9-ho1', workflowId: 'rv9-ho1', args: [{ machine: 'customer-brief', input: {} }], workflowExecutionTimeout: '60s' });
    try {
      const s = await until(async () => { const x = await h.query('polyflow.state'); return x.orders.length ? x : null; }, 'the first order');
      // An identity hand-over (the gate's auto-upgrade, or DST's 'handover' move) ...
      await h.executeUpdate('polyflow.migrate', { args: [{ snapshot: s.state, from: digest(s.state) }] });
      // ... and the agent reports its order while the old execution flushes its ledger.
      // (Response: during a hand-over an Update is REFUSED with a retryable reason, never
      // accepted and lost; the caller retries, as any Temporal client retries, and reaches the next execution.)
      let r;
      for (let i = 0; i < 50 && !r; i++) {
        try { r = await env.client.workflow.getHandle('rv9-ho1').executeUpdate('polyflow.report', { args: [{ orderId: s.orders[0].orderId, ok: true, result: { count: 2 }, actor: { id: 'alice', roles: ['agent'] } }] }); } catch (err) { if (!/handing over/.test(msg(err))) throw err; await sleep(100); }
      }
      assert.equal(r.stepKind, 'accepted', 'fixture: the report is accepted and answered');
      const later = await until(async () => { const d = await env.client.workflow.getHandle('rv9-ho1').describe(); return d.runId !== h.firstExecutionRunId ? h.query('polyflow.state') : null; }, 'the hand-over');
      assert.equal(later.state.briefState, r.state.briefState,
        `HO1: the report was answered 'accepted' (${r.state.briefState}), and the next execution is back in '${later.state.briefState}' with ${later.orders.map((o) => o.kind).join(', ')} open again: handOver() computed the carried snapshot BEFORE the Continue-as-New interceptor's flush, and an Update accepted during that flush steps a state nobody carries`);
    } finally {
      await h.terminate('review done').catch(() => {});
    }
  });
});

test('AP1 (plan P5.6): the approved call executes exactly the arguments the approver saw', async () => {
  const sent = [];
  const policy = {
    policy: 'p56', version: 1,
    effects: { send_email: { kind: 'email', class: 'irreversible', labels: ['egress'] }, ask_approval: { kind: 'approval', class: 'none' } },
    rules: [{ id: 'approve-each-email', type: 'requires-prior', guards: 'email', prior: 'approval', bind: 'per-effect' }],
    escalation: { role: 'approver', timeoutMs: 60_000 },
  };
  const sink = memorySink();
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'rv9-ap1', workflowsPath: `${fixtures}review-p9-workflows.mjs`, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
    activities: { send_email: async ({ to }) => { sent.push(to); return `sent:${to}`; }, ask_approval: async () => ({}) },
    plugins: [new PolyflowPlugin({ level: 'guard', policy, sink })],
  });
  await worker.runUntil(async () => {
    const h = await env.client.workflow.start('editWhileParked', { taskQueue: 'rv9-ap1', workflowId: 'rv9-ap1', args: [{ to: 'cfo@acme.example', body: 'Q3 numbers' }], workflowExecutionTimeout: '60s' });
    const [p] = await until(async () => { const x = await h.query('polyflow.pending'); return x.length ? x : null; }, 'the escalation');
    assert.deepEqual(p.args, [{ to: 'cfo@acme.example', body: 'Q3 numbers' }], 'fixture: the approver is shown the call as proposed');
    // The loop edits its draft while the call waits; then the approver approves what they were shown.
    await h.executeUpdate('edit', { args: [{ to: 'attacker@evil.example' }] });
    await h.executeUpdate('polyflow.approve', { args: [{ approvalId: p.approvalId, decision: 'approve', principal: 'alice', argsDigest: p.argsDigest }] });
    await h.result();
  });
  const effect = sink.read(sink.runs()[0]).events.find((e) => e.kind === 'effect' && e.body.activityType === 'send_email');
  assert.deepEqual(sent, ['cfo@acme.example'],
    `AP1: the approver approved ${p0(effect)} for cfo@acme.example; the activity ran with ${JSON.stringify(sent)}. The parked call holds a REFERENCE to the workflow's argument objects, is serialised only when next() runs after the approval, and nothing re-checks the digest the ledger records`);
});
const p0 = (effect) => `argsDigest ${effect?.body?.argsDigest?.slice(0, 20)}…`;

/** Drive customer-brief (external mode, verified principals) to `review`. */
async function toReview(h, wf) {
  // (Response: report tokens are bound to the attempt and the outcome, PR1.)
  const agent = (o, result) => signPrincipal({ id: 'agent-7', roles: ['agent'], aud: 'default', act: { op: 'report', wf, ref: o.orderId, attempt: o.attempt, digest: digest({ ok: true, result, error: '', permanent: false }) } }, idp);
  const next = (kind) => until(async () => { const s = await h.query('polyflow.state'); return s.orders.find((o) => o.kind === kind) ?? null; }, kind);
  let o = await next('fetch_tickets');
  await h.executeUpdate('polyflow.report', { args: [{ orderId: o.orderId, ok: true, result: { count: 3 }, actor: agent(o, { count: 3 }) }] });
  o = await next('draft_brief');
  await h.executeUpdate('polyflow.report', { args: [{ orderId: o.orderId, ok: true, result: {}, actor: agent(o, {}) }] });
  await next('request_approval');
  return h.query('polyflow.state');
}

test('PR1 (P9 security Response, SEC-PR1): a report token read from history cannot report a DIFFERENT outcome for the same order', async () => {
  const worker = await governedWorker('rv9-pr1', { principals });
  await worker.runUntil(async () => {
    const wf = 'rv9-pr1';
    const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'rv9-pr1', workflowId: wf, args: [{ machine: 'customer-brief', input: {} }], workflowExecutionTimeout: '60s' });
    try {
      const o = await until(async () => (await h.query('polyflow.state')).orders[0] ?? null, 'the first order');
      const token = signPrincipal({ id: 'agent-7', roles: ['agent'], aud: 'default', act: { op: 'report', wf, ref: o.orderId, attempt: o.attempt, digest: digest({ ok: false, result: {}, error: 'upstream 503', permanent: false }) } }, idp);
      // The agent reports a retryable failure: the order stays open, re-offered.
      await h.executeUpdate('polyflow.report', { args: [{ orderId: o.orderId, ok: false, error: 'upstream 503', actor: token }] });
      // A history reader lifts the token and reports success, with a result of their choosing.
      const [lifted] = await acceptedUpdateArgs(h, 'polyflow.report');
      let r = null;
      try { r = await h.executeUpdate('polyflow.report', { args: [{ orderId: o.orderId, ok: true, result: { count: 5 }, actor: lifted.actor }] }); } catch (err) { r = { refused: msg(err) }; }
      assert.ok(r.refused, `PR1: a token lifted from history reported the order a success with a forged result (${JSON.stringify(r)}): act binds { op, wf, ref: orderId } only, not the outcome or the result, and a retried order stays open for the token's whole life`);
    } finally {
      await h.terminate('review done').catch(() => {});
    }
  });
});

test('MG1 (P9 security Response, SEC-MG1): the gate\'s migrate token, read from history, cannot move the run into a state the gate never decided', async () => {
  const worker = await governedWorker('rv9-mg1', { principals });
  await worker.runUntil(async () => {
    const wf = 'rv9-mg1';
    const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'rv9-mg1', workflowId: wf, args: [{ machine: 'customer-brief', input: {} }], workflowExecutionTimeout: '60s' });
    const g = env.client.workflow.getHandle(wf);
    try {
      const s = await toReview(h, wf);
      assert.equal(s.state.briefState, 'review');
      // What gate-activities.mjs does for an auto-upgrade: an identity migration, signed for { op, wf, ref: from }.
      const from = digest(s.state);
      // (Response: a migrate token also binds the run and the target, MG1.)
      const gateToken = signPrincipal({ id: 'polyflow-gate', roles: ['operator'], aud: 'default', act: { op: 'migrate', wf, ref: from, run: h.firstExecutionRunId, to: digest(s.state) } }, idp);
      await h.executeUpdate('polyflow.migrate', { args: [{ snapshot: s.state, from, principal: gateToken }] });
      await until(async () => (await g.describe()).runId !== h.firstExecutionRunId, 'the hand-over');
      // The next execution holds the SAME state, so `from` still matches. A history reader lifts the token.
      const [lifted] = await acceptedUpdateArgs(env.client.workflow.getHandle(wf, h.firstExecutionRunId), 'polyflow.migrate');
      let r;
      try { r = await g.executeUpdate('polyflow.migrate', { args: [{ snapshot: { ...s.state, briefState: 'posting' }, from, principal: lifted.principal }] }); } catch (err) { r = { refused: msg(err) }; }
      const after = r.refused ? null : await until(async () => { const x = await g.query('polyflow.state'); return x.state.briefState === 'posting' ? x : null; }, 'posting', 50).catch(() => null);
      assert.ok(r.refused, `MG1: the lifted gate token moved a run waiting for approval into 'posting' (state ${after?.state?.briefState ?? '?'}, open orders ${JSON.stringify(after?.orders?.map((o) => o.kind) ?? r)}): no approver decided, and 'posting' is declared unstoppable, so the run can now neither post nor stop. act binds { op, wf, ref: from }, not the snapshot, and an identity migration leaves 'from' valid on the next execution`);
    } finally {
      await g.terminate('review done').catch(() => {});
    }
  });
});

const P55 = {
  policy: 'p55', version: 1,
  effects: {
    send_email: { kind: 'email', class: 'irreversible', labels: ['egress'] },
    fetch_url: { kind: 'fetch', class: 'none', labels: ['reads-untrusted'] },
    read_crm: { kind: 'read', class: 'none', labels: ['reads-private'] },
  },
  rules: [{ id: 'trifecta', type: 'trifecta', outcome: 'escalate' }],
  escalation: { role: 'approver', timeoutMs: 60_000 },
};

test('RT1: after an approver key is rotated out of `principals`, runs that recorded its approvals still replay', async () => {
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'rv9-rt1', workflowsPath: `${fixtures}guard-workflows.mjs`, maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
    activities: { send_email: async ({ to }) => `sent:${to}`, fetch_url: async () => 'page', read_crm: async () => 'customer' },
    plugins: [new PolyflowPlugin({ level: 'guard', policy: P55, sink: memorySink(), principals })],
  });
  const history = await worker.runUntil(async () => {
    const h = await env.client.workflow.start('trifecta', { taskQueue: 'rv9-rt1', workflowId: 'rv9-rt1', args: [{ url: 'https://x', to: 'x@y' }], workflowExecutionTimeout: '60s' });
    const [p] = await until(async () => { const x = await h.query('polyflow.pending'); return x.length ? x : null; }, 'the escalation');
    const act = { op: 'approve', wf: 'rv9-rt1', run: h.firstExecutionRunId, ref: p.approvalId, decision: 'approve', argsDigest: p.argsDigest };
    await h.executeUpdate('polyflow.approve', { args: [{ approvalId: p.approvalId, decision: 'approve', principal: signPrincipal({ id: 'alice', roles: ['approver'], aud: 'default', act }, idp) }] });
    await h.result();
    return h.fetchHistory();
  });
  const replay = (trust) => Worker.runReplayHistory({ workflowsPath: `${fixtures}guard-workflows.mjs`, bundlerOptions: { logger: quiet }, plugins: [new PolyflowPlugin({ level: 'guard', policy: P55, sink: memorySink(), principals: trust })] }, history, 'rv9-rt1');
  await replay(principals); // control: the same trust store replays clean
  const rotated = { 'idp-2026-10': generateSigningKey('idp-2026-10').publicKeyPem }; // idp revoked, its successor trusted
  const err = await replay(rotated).then(() => null, (e) => e);
  assert.equal(err, null, 'RT1: the approval handler re-verifies the token on REPLAY (workflow-interceptors.mjs approveUpdate handler); with the key gone it throws a plain Error, which fails the workflow task: every in-flight run that holds an approval by a revoked key is wedged on its next replay. Replay: ' + msg(err));
});

test('SH1 (plan P2.6): turning header sealing on does not strand a run that continued-as-new before it was on', async () => {
  const policy = {
    policy: 'gc', version: 1,
    effects: { slack_send: { kind: 'post', class: 'irreversible', labels: ['egress'] }, ask_approval: { kind: 'approval', class: 'none' } },
    rules: [{ id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' }, { id: 'at-most-one-post', type: 'at-most', guards: 'post', n: 1 }],
  };
  const { history } = await runWith(env, {
    taskQueue: 'rv9-sh1', workflowId: 'rv9-sh1', workflowsPath: `${fixtures}review-p4p5-workflows.mjs`,
    activities: { ask_approval: async () => ({}), slack_send: async () => ({}) },
    plugins: [new PolyflowPlugin({ level: 'guard', policy, sink: memorySink() })], workflow: 'postAcrossContinueAsNew', args: [{}],
  });
  assert.ok(history.events[0].workflowExecutionStartedEventAttributes.continuedExecutionRunId, 'fixture: this is the continued execution');
  const replay = (headerKey) => Worker.runReplayHistory({ workflowsPath: `${fixtures}review-p4p5-workflows.mjs`, bundlerOptions: { logger: quiet }, plugins: [new PolyflowPlugin({ level: 'guard', policy, sink: memorySink(), ...(headerKey ? { headerKey } : {}) })] }, history, 'rv9-sh1');
  await replay(null); // control
  const err = await replay({ keyId: 'dk-new', key: randomBytes(32).toString('base64') }).then(() => null, (e) => e);
  assert.equal(err, null, 'SH1: a worker with headerKey refuses the plaintext head a pre-sealing worker handed over (openHeader required: true in execute), so every chain that continued-as-new before the rollout fails its next workflow task: enabling P2.6 on a live fleet wedges it. Replay: ' + msg(err));
});
