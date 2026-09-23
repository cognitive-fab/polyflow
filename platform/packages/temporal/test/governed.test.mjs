// G2 Govern — FR-GOV.1–.7, .11: the customer-brief machine from polyflow's
// library, unmodified, running on Temporal. The scenarios mirror polyflow's own
// e2e suite (test/e2e.test.mjs at the repository root).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { KeyError } from '@cognitive-fab/polyflow-kernel';
import { PolyflowPlugin, memorySink, startGoverned, loadMachineDir } from '../src/index.mjs';
import { startEnv, fixtures, scheduled, quiet } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const { descriptor } = loadMachineDir(BRIEF);
const governed = fixtures + 'governed-workflows.mjs';

const brief = (over = {}) => ({
  fetch_tickets: async () => ({ count: 3 }),
  draft_brief: async () => ({}),
  request_approval: async () => ({}),
  post_brief: async () => ({}),
  ...over,
});

async function worker(taskQueue, activities = brief(), plugins = [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF }, allowUncertified: true })]) {
  return Worker.create({
    connection: env.nativeConnection, taskQueue, workflowsPath: governed, activities, plugins,
    maxCachedWorkflows: 0, bundlerOptions: { logger: quiet },
  });
}

const start = (taskQueue, date, extra = {}) => startGoverned(env.client, { descriptor, input: { date }, taskQueue, workflowExecutionTimeout: '60s', ...extra });

test('happy path: one order at a time, ending posted, on Temporal', async () => {
  const w = await worker('g2-a');
  const out = await w.runUntil(async () => {
    const r = await start('g2-a', '2026-08-25');
    assert.equal(r.workflowId, 'polyflow/customer-brief/2026-08-25');
    assert.equal(r.status, 'started');
    return r.handle.result();
  });
  assert.equal(out.state.briefState, 'posted');
  const history = await env.client.workflow.getHandle('polyflow/customer-brief/2026-08-25').fetchHistory();
  assert.deepEqual(scheduled(history).filter((t) => !t.startsWith('polyflow.')), ['fetch_tickets', 'draft_brief', 'request_approval', 'post_brief']);
});

test('the run id is derived from input: a second start attaches, a bad field is an instruction', async () => {
  const gate = { open: null };
  const w = await worker('g2-b', brief({ request_approval: () => new Promise((resolve) => { gate.open = resolve; }) }));
  await w.runUntil(async () => {
    const a = await start('g2-b', '2026-02-01');
    const b = await start('g2-b', '2026-02-01', {});
    assert.equal(b.status, 'attached');
    assert.equal(b.workflowId, a.workflowId);
    await assert.rejects(start('g2-b', 'yesterday'), (err) => err instanceof KeyError && /does not match/.test(err.message) && /a second key would run the job again/.test(err.message));
    while (!gate.open) await new Promise((r) => setTimeout(r, 50));
    gate.open({});
    await a.handle.result();
    const c = await start('g2-b', '2026-02-01');
    assert.equal(c.status, 'complete');
    assert.match(c.note, /Do NOT start another run/);
  });
});

test('a denial is a result, not a fault — and no post is ever ordered', async () => {
  const w = await worker('g2-c', brief({ request_approval: async () => { throw ApplicationFailure.nonRetryable('not-ready', 'Permanent'); } }));
  const out = await w.runUntil(async () => (await start('g2-c', '2026-03-01')).handle.result());
  assert.equal(out.state.briefState, 'denied');
  const history = await env.client.workflow.getHandle('polyflow/customer-brief/2026-03-01').fetchHistory();
  assert.ok(!scheduled(history).includes('post_brief'));
});

test('zero tickets ends the run rather than drafting an empty brief', async () => {
  const w = await worker('g2-d', brief({ fetch_tickets: async () => ({ count: 0 }) }));
  const out = await w.runUntil(async () => (await start('g2-d', '2026-03-02')).handle.result());
  assert.deepEqual(out.state, { briefState: 'denied', ticketCount: 0, reason: 'no-empty-brief' });
});

test('a stale proposal is refused by the acceptor before it enters history; a duplicate is answered once', async () => {
  const gate = { open: null };
  const w = await worker('g2-e', brief({ draft_brief: () => new Promise((resolve) => { gate.open = resolve; }) }));
  await w.runUntil(async () => {
    const { handle } = await start('g2-e', '2026-03-03');
    while (!gate.open) await new Promise((r) => setTimeout(r, 50));
    try {
      // The run is drafting: a POST_DONE now is a stale completion — and a bare
      // completion, naming no order, is refused before the machine sees it.
      await assert.rejects(
        handle.executeUpdate('polyflow.propose', { args: [{ action: 'POST_DONE', actionId: 'x1' }] }),
        (err) => /report it against the order/.test(`${err.message} ${err.cause?.message}`),
      );
      const s = await handle.query('polyflow.state');
      assert.equal(s.state.briefState, 'drafting');
      assert.deepEqual(s.orders.map((o) => [o.kind, o.tool]), [['draft_brief', 'ask']]);
    } finally {
      gate.open({}); // never leave an activity parked: the worker would wait for it forever
    }
    // The completion the worker already delivered, re-delivered by hand under
    // the same id, is a duplicate: answered from the record, not stepped again.
    let st;
    for (let i = 0; i < 100; i++) { st = await handle.query('polyflow.state'); if (st.state.briefState !== 'drafting') break; await new Promise((r) => setTimeout(r, 50)); }
    const orderId = (await handle.query('polyflow.journal')).find((j) => j.action === 'DRAFT_READY').actionId;
    const again = await handle.executeUpdate('polyflow.propose', { args: [{ action: 'DRAFT_READY', actionId: orderId }] });
    assert.equal(again.deduped, true);
    await handle.result();
  });
});

test('an out-of-band action that does not apply is recorded as a reject, and changes nothing', async () => {
  const gate = { open: null };
  const w = await worker('g2-f', brief({ fetch_tickets: () => new Promise((resolve) => { gate.open = resolve; }) }));
  await w.runUntil(async () => {
    const { handle } = await start('g2-f', '2026-03-04');
    while (!gate.open) await new Promise((r) => setTimeout(r, 50));
    await handle.signal('polyflow.propose', { action: 'START', actionId: 'sig-1' });
    let j;
    for (let i = 0; i < 100; i++) { j = await handle.query('polyflow.journal'); if (j.some((x) => x.actionId === 'sig-1')) break; await new Promise((r) => setTimeout(r, 50)); }
    const row = j.find((x) => x.actionId === 'sig-1');
    assert.equal(row.stepKind, 'rejected');
    assert.equal(row.rejectReason, 'already-started');
    assert.deepEqual(row.pre, row.post);
    gate.open({ count: 2 });
    const out = await handle.result();
    assert.equal(out.state.briefState, 'posted');
  });
});

test('a run outlives its worker: a new worker picks it up and exactly one post happens', async () => {
  let posts = 0;
  const failing = await worker('g2-g', brief({ request_approval: async () => { throw new Error('approval service down'); } }));
  const { handle } = await failing.runUntil(async () => {
    const r = await start('g2-g', '2026-03-05');
    for (let i = 0; i < 100; i++) { const s = await r.handle.query('polyflow.state'); if (s.state.briefState === 'review') break; await new Promise((res) => setTimeout(res, 50)); }
    return r;
  });
  // The first worker is gone. A second process, with no memory of the first,
  // finishes the run from Temporal's history.
  const healthy = await worker('g2-g', brief({ post_brief: async () => { posts++; return {}; } }));
  const out = await healthy.runUntil(handle.result());
  assert.equal(out.state.briefState, 'posted');
  assert.equal(posts, 1);
});

test('governed histories replay with zero non-determinism errors', async () => {
  const w = await worker('g2-h');
  await w.runUntil(async () => (await start('g2-h', '2026-03-06')).handle.result());
  const history = await env.client.workflow.getHandle('polyflow/customer-brief/2026-03-06').fetchHistory();
  await Worker.runReplayHistory({
    workflowsPath: governed, bundlerOptions: { logger: quiet }, replayName: 'g2-h',
    plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF }, allowUncertified: true })],
  }, history);
});

test('G2 and G1 compose: the guard sees the machine\'s work orders like any other activity', async () => {
  const sink = memorySink();
  const plugin = new PolyflowPlugin({
    level: 'guard', sink, machines: { 'customer-brief': BRIEF }, allowUncertified: true,
    policy: {
      policy: 'brief', version: 1,
      effects: {
        fetch_tickets: { kind: 'fetch', class: 'none' },
        draft_brief: { kind: 'draft', class: 'none' },
        request_approval: { kind: 'approval', class: 'none' },
        post_brief: { kind: 'post', class: 'irreversible', labels: ['egress'] },
      },
      rules: [{ id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' }],
    },
  });
  const w = await worker('g2-i', brief(), [plugin]);
  const out = await w.runUntil(async () => (await start('g2-i', '2026-03-07')).handle.result());
  assert.equal(out.state.briefState, 'posted');
  const events = sink.read(sink.runs()[0]).events;
  const allowedPost = events.find((e) => e.kind === 'verdict' && e.body.outcome === 'allowed' && e.body.rules.includes('no-post-without-approval'));
  assert.ok(allowedPost, 'the post was checked, and allowed because an approval had succeeded');
});
