// Review P2/P3 (docs/platform/reviews/P2-P3-review.md): Temporal-binding findings.
// Each test asserts what the spec claims; each failed against the code as
// reviewed and is kept as a regression test. Ids match the review's findings table. Every test that parks an
// activity releases it in a `finally`, and every run it leaves open is terminated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { PolyflowPlugin, memorySink, startGoverned, loadMachineDir } from '../src/index.mjs';
import { startEnv, fixtures, scheduled, quiet } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const wf = fixtures + 'review-p2p3-workflows.mjs';
const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const PROBE = fixtures + 'review-p2p3-machine';
const brief = loadMachineDir(BRIEF).descriptor;
const probe = loadMachineDir(PROBE).descriptor;
const T = { timeout: 120_000 };

const until = async (fn, tries = 100) => {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  return null;
};
const makeWorker = (taskQueue, activities, plugins) => Worker.create({
  connection: env.nativeConnection, taskQueue, workflowsPath: wf, activities, plugins,
  maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
});
const govPlugin = () => new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF, 'review-probe': PROBE }, allowUncertified: true });
const terminate = async (id) => { try { await env.client.workflow.getHandle(id).terminate('review cleanup'); } catch { /* already closed */ } };

// ---- G1 ---------------------------------------------------------------------

test('review G1: a signal to an external workflow crosses the guard (FR-GRD.1)', T, async () => {
  const sink = memorySink();
  const policy = { policy: 'strict', version: 1, effects: { noop: { kind: 'noop' } }, unlabelled: 'deny', rules: [] };
  const w = await makeWorker('r-g1', {}, [new PolyflowPlugin({ level: 'guard', policy, sink })]);
  await w.runUntil(async () => {
    const target = await env.client.workflow.start('pingTarget', { taskQueue: 'r-g1', workflowId: 'r-g1-target', workflowExecutionTimeout: '30s' });
    const s = await env.client.workflow.start('signaller', { taskQueue: 'r-g1', workflowId: 'r-g1-signaller', args: [{ targetId: 'r-g1-target' }], workflowExecutionTimeout: '30s' });
    await s.result().catch(() => {});
    await terminate('r-g1-target');
    void target;
  });
  const run = sink.runs().find((r) => r.wf === 'r-g1-signaller');
  const verdicts = sink.read(run).events.filter((e) => e.kind === 'verdict');
  assert.ok(verdicts.length > 0, 'the external signal was sent with no proposal and no verdict: unlabelled "deny" never saw it');
});

test('review G7: a Temporal retry of a local activity is not a new effect (tech spec §6.3)', T, async () => {
  let attempts = 0;
  const policy = {
    policy: 'one-post', version: 1,
    effects: { slack_send: { kind: 'post', class: 'irreversible', labels: ['egress'] } },
    rules: [{ id: 'at-most-one-post', type: 'at-most', guards: 'post', n: 1 }],
  };
  const w = await makeWorker('r-g7', {
    slack_send: async ({ text }) => { attempts += 1; if (attempts === 1) throw new Error('upstream 503'); return `posted:${text}`; },
  }, [new PolyflowPlugin({ level: 'guard', policy, sink: memorySink() })]);
  const result = await w.runUntil(env.client.workflow.execute('localPoster', {
    taskQueue: 'r-g7', workflowId: 'r-g7', args: [{ text: 'hi' }], workflowExecutionTimeout: '60s',
  }).catch((err) => `failed: ${err.cause?.message ?? err.message}`));
  assert.equal(result, 'posted:hi', `the retry after backoff re-entered the guard as a second post (attempts: ${attempts})`);
});

test('review G8: an escalation whose effect is cancelled leaves nothing pending and cannot be approved afterwards', T, async () => {
  const sink = memorySink();
  const policy = {
    policy: 'approve-each', version: 1,
    effects: { send_email: { kind: 'email', class: 'irreversible', labels: ['egress'] }, approval_tool: { kind: 'approval', class: 'none' } },
    rules: [{ id: 'approve-each-email', type: 'requires-prior', guards: 'email', prior: 'approval', bind: 'per-effect' }],
    escalation: { role: 'approver', timeoutMs: 60_000 },
  };
  const w = await makeWorker('r-g8', { send_email: async ({ to }) => `sent:${to}`, approval_tool: async () => 'ok' },
    [new PolyflowPlugin({ level: 'guard', policy, sink })]);
  const { pending, approve, result } = await w.runUntil(async () => {
    const h = await env.client.workflow.start('impatientEmailer', { taskQueue: 'r-g8', workflowId: 'r-g8', args: [{ to: 'a@x' }], workflowExecutionTimeout: '30s' });
    const first = await until(async () => { const p = await h.query('polyflow.pending'); return p.length ? p : null; });
    assert.ok(first, 'the email escalated');
    await new Promise((r) => setTimeout(r, 2000)); // the workflow gave up on the email after 1 s
    const stale = await h.query('polyflow.pending');
    const answer = await h.executeUpdate('polyflow.approve', { args: [{ approvalId: first[0].approvalId, decision: 'approve', principal: 'bob' }] })
      .then(() => 'accepted', () => 'refused');
    return { pending: stale, approve: answer, result: await h.result() };
  });
  assert.match(result, /^gave up/);
  assert.deepEqual(pending, [], 'the escalation of an effect the workflow abandoned is still in the inbox');
  assert.equal(approve, 'refused', 'a principal approved an effect nobody is waiting for; the approval is recorded as a human proposal');
});

// ---- G2 ---------------------------------------------------------------------

test('review C1: startGoverned never runs a governed machine under an id it did not derive (FR-GOV.5)', T, async () => {
  // Fixed by refusing identity options outright, rather than silently overriding them.
  await assert.rejects(startGoverned(env.client, {
    descriptor: brief, input: { date: '2026-04-01' }, taskQueue: 'r-c1-nobody',
    workflowId: 'whatever-the-agent-likes', workflowIdReusePolicy: 'ALLOW_DUPLICATE', workflowExecutionTimeout: '30s',
  }), /derives the run's identity; it does not take workflowId, workflowIdReusePolicy/);
});

test('review S1: an out-of-band proposal cannot complete an order addressed to a human (the agent approves itself)', T, async () => {
  const gate = { open: null };
  let posts = 0;
  const w = await makeWorker('r-s1', {
    fetch_tickets: async () => ({ count: 3 }),
    draft_brief: async () => ({}),
    request_approval: () => new Promise((resolve) => { gate.open = resolve; }),
    post_brief: async () => { posts += 1; return {}; },
  }, [govPlugin()]);
  await w.runUntil(async () => {
    const { handle } = await startGoverned(env.client, { descriptor: brief, input: { date: '2026-04-02' }, taskQueue: 'r-s1', workflowExecutionTimeout: '60s' });
    try {
      await until(() => gate.open);
      // The human has not answered. Whoever can send an Update answers for them.
      await assert.rejects(
        handle.executeUpdate('polyflow.propose', { args: [{ action: 'APPROVED', actionId: 'self-approve' }] }),
        'APPROVED is the completion of the open request_approval order; an unrelated caller proposed it and it was accepted',
      );
      await new Promise((r) => setTimeout(r, 1000));
      // Checked BEFORE the human answers: releasing the gate below IS the human's approval.
      assert.equal(posts, 0, 'the brief was posted without a human approval');
      assert.equal((await handle.query('polyflow.state')).state.briefState, 'review');
    } finally {
      gate.open?.({});
      await handle.result().catch(() => {});
    }
  });
});

test('review S2: a caller cannot start a governed run inside an arbitrary state (snapshot is for Continue-as-New)', T, async () => {
  const w = await makeWorker('r-s2', {
    fetch_tickets: async () => ({ count: 3 }), draft_brief: async () => ({}), request_approval: async () => ({}), post_brief: async () => ({}),
  }, [govPlugin()]);
  const outcome = await w.runUntil(async () => {
    const h = await env.client.workflow.start('GovernedWorkflow', {
      taskQueue: 'r-s2', workflowId: 'polyflow/customer-brief/2026-04-03', workflowExecutionTimeout: '30s',
      args: [{ machine: 'customer-brief', snapshot: { briefState: 'review', ticketCount: 3, reason: '' } }],
    });
    try {
      await h.executeUpdate('polyflow.propose', { args: [{ action: 'APPROVED' }] });
    } catch { /* refused: good */ }
    return h.result().then((r) => r.state.briefState, () => 'refused');
  });
  const history = await env.client.workflow.getHandle('polyflow/customer-brief/2026-04-03').fetchHistory();
  const ran = scheduled(history).filter((t) => !t.startsWith('polyflow.'));
  assert.equal(outcome, 'refused', `the forged run ended '${outcome}' having run ${JSON.stringify(ran)}: a post with no approval ever requested`);
});

test('review P1: a completion that lands while the run is quarantined is recorded, not dropped (FR-GOV.3, FR-GOV.11)', T, async () => {
  const gate = { open: null };
  const w = await makeWorker('r-p1', {
    work: () => new Promise((resolve) => { gate.open = resolve; }),
    notify: async () => ({}),
  }, [govPlugin()]);
  const { handle, journal } = await w.runUntil(async () => {
    const r = await startGoverned(env.client, { descriptor: probe, input: { id: 'p1' }, taskQueue: 'r-p1', workflowExecutionTimeout: '60s' });
    try {
      await until(() => gate.open);
      await r.handle.signal('polyflow.propose', { action: 'BOOM', actionId: 'boom' });
      assert.ok(await until(async () => (await r.handle.query('polyflow.state')).poisoned), 'BOOM poisons the run');
    } finally {
      gate.open?.({}); // the work order completes while the run is quarantined
    }
    await new Promise((res) => setTimeout(res, 1500));
    return { handle: r.handle, journal: await r.handle.query('polyflow.journal') };
  });
  await terminate(handle.workflowId);
  assert.ok(journal.some((j) => j.action === 'WORK_DONE'), `the work order's completion is nowhere in the journal: ${JSON.stringify(journal.map((j) => [j.action, j.stepKind]))}`);
});

test('review P2: release refuses a snapshot the machine cannot hold', T, async () => {
  const gate = { open: null };
  const w = await makeWorker('r-p2', { work: () => new Promise((resolve) => { gate.open = resolve; }), notify: async () => ({}) }, [govPlugin()]);
  const answer = await w.runUntil(async () => {
    const r = await startGoverned(env.client, { descriptor: probe, input: { id: 'p2' }, taskQueue: 'r-p2', workflowExecutionTimeout: '60s' });
    try {
      await until(() => gate.open);
      await r.handle.signal('polyflow.propose', { action: 'BOOM', actionId: 'boom' });
      await until(async () => (await r.handle.query('polyflow.state')).poisoned);
      return await r.handle.executeUpdate('polyflow.release', { args: [{ snapshot: { anything: 'at all' } }] }).then(() => 'accepted', () => 'refused');
    } finally {
      gate.open?.({});
      await terminate(r.workflowId);
    }
  });
  assert.equal(answer, 'refused', 'a snapshot with none of the contract\'s state keys was accepted as the run\'s new state');
});

test('review T1: an effect ordered by the step that reaches a terminal state is carried out, as in polyrun', T, async () => {
  let notified = 0;
  const w = await makeWorker('r-t1', { work: async () => ({}), notify: async () => { notified += 1; return {}; } }, [govPlugin()]);
  const out = await w.runUntil(async () => {
    const r = await startGoverned(env.client, { descriptor: probe, input: { id: 't1' }, taskQueue: 'r-t1', workflowExecutionTimeout: '60s' });
    await until(async () => (await r.handle.query('polyflow.state')).state.phase === 'ready');
    await r.handle.executeUpdate('polyflow.propose', { args: [{ action: 'FINISH' }] });
    return r.handle.result();
  });
  assert.equal(out.state.phase, 'done');
  assert.equal(notified, 1, 'the notify order emitted on entering `done` was cancelled in the same step and never ran');
});
