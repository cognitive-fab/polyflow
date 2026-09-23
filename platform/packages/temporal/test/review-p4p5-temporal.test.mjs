// Review P4/P5 — governed runs: start arguments, reports, claims, migration.
// Each test asserts what the spec (or the prior review's fix) claims, and each
// FAILS today. See docs/platform/reviews/P4-P5-review.md for the findings.
//
// Every parked activity is released in a `finally`, and every run a test
// leaves open is terminated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import { PolyflowPlugin, memorySink, startGoverned, loadMachineDir } from '../src/index.mjs';
import { startEnv, fixtures, scheduled, quiet } from './helpers.mjs';
import { digest } from '@cognitive-fab/polyflow-kernel';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const { descriptor } = loadMachineDir(BRIEF);

/** Activities whose waits end when the test says so, or when the workflow calls them off. */
function parkable() {
  const gate = { open: false, posts: 0 };
  const park = async (answer) => {
    for (;;) {
      if (gate.open) return answer;
      Context.current().heartbeat();
      await Context.current().sleep(50); // throws when the workflow cancels the order
    }
  };
  return {
    gate,
    activities: {
      fetch_tickets: async () => (gate.fetchParks ? park({ count: 3 }) : { count: 3 }),
      draft_brief: async () => ({}),
      request_approval: async () => park({}),
      post_brief: async () => { gate.posts += 1; return {}; },
    },
  };
}

const makeWorker = (taskQueue, activities) => Worker.create({
  connection: env.nativeConnection, taskQueue, workflowsPath: `${fixtures}governed-workflows.mjs`, activities, maxCachedWorkflows: 0,
  bundlerOptions: { logger: quiet },
  plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF }, allowUncertified: true, externalMode: 'allowed' })],
});

const until = async (fn, what, n = 200) => {
  for (let i = 0; i < n; i++) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}`);
};
const stateOf = (h) => h.query('polyflow.state');
const terminate = async (id) => { try { await env.client.workflow.getHandle(id).terminate('review test cleanup'); } catch { /* closed */ } };
/** The run failed at once, refusing its start arguments. */
const refusedAtStart = (h) => until(async () => {
  const d = await h.describe();
  if (d.status.name === 'RUNNING') return scheduled(await h.fetchHistory()).includes('fetch_tickets') ? 'running' : null;
  return d.status.name;
}, 'the start to be decided').then(async (st) => {
  if (st === 'running') return false;
  const e = await h.result().then(() => null, (x) => x);
  assert.match(`${e?.cause?.message}`, /accepted only across Continue-as-New/);
  return true;
});
const msg = (e) => `${e?.message} ${e?.cause?.message ?? ''}`;

/** Drive an external-mode run to `review` through reports, as the gateway does. */
async function toReview(h) {
  for (const result of [{ count: 3 }, {}]) {
    const s = await until(async () => { const x = await stateOf(h); return x.orders.length ? x : null; }, 'an open order');
    await h.executeUpdate('polyflow.report', { args: [{ orderId: s.orders[0].orderId, ok: true, result }] });
  }
  return until(async () => { const x = await stateOf(h); return x.state.briefState === 'review' && x.orders.length ? x : null; }, 'review');
}

// FO1 (blocker) — `orders` and `timers` are Continue-as-New carry fields, but
// GovernedWorkflow accepts them from ANY start. The snapshot check added for
// review S2 guards `snapshot` only. A forged start orders `post_brief` with a
// payload of the caller's choosing; no machine step emitted it.
test('FO1: a fresh start cannot hand the run work orders the machine never emitted', async () => {
  const p = parkable();
  p.gate.fetchParks = true;
  const w = await makeWorker('rv45-fo1', p.activities);
  const id = 'rv45-fo1-run';
  try {
    await w.runUntil(async () => {
      const h = await env.client.workflow.start('GovernedWorkflow', {
        taskQueue: 'rv45-fo1', workflowId: id, workflowExecutionTimeout: '60s',
        args: [{ machine: 'customer-brief', input: {}, orders: [{ intentId: 'forged-1', kind: 'post_brief', payload: { ticketCount: 99 } }] }],
      });
      // Refusing the start outright is the fix (the run fails with PolyflowSnapshotRefused).
      if (await refusedAtStart(h)) return;
      await until(async () => scheduled(await h.fetchHistory()).includes('fetch_tickets'), 'the first task');
      await new Promise((r) => setTimeout(r, 300));
      const types = scheduled(await h.fetchHistory());
      assert.ok(!types.includes('post_brief'), `post_brief was scheduled from start arguments (posts: ${p.gate.posts}); the machine is in '${(await stateOf(h)).state.briefState}'`);
    });
  } finally {
    p.gate.open = true;
    await terminate(id);
  }
});

// FO2 (blocker) — a forged carried timer is stepped with source 'timer', which
// skips the completion-action check (review S1's fix lives in propose only):
// the fetch order's completion is delivered by the caller.
test('FO2: a fresh start cannot hand the run a timer that delivers an order completion', async () => {
  const p = parkable();
  p.gate.fetchParks = true;
  const w = await makeWorker('rv45-fo2', p.activities);
  const id = 'rv45-fo2-run';
  try {
    await w.runUntil(async () => {
      const h = await env.client.workflow.start('GovernedWorkflow', {
        taskQueue: 'rv45-fo2', workflowId: id, workflowExecutionTimeout: '60s',
        args: [{ machine: 'customer-brief', input: {}, timers: [{ key: 'forged', fireAt: Date.now() + 200, action: 'TICKETS_READY', data: { count: 7 } }] }],
      });
      if (await refusedAtStart(h)) return;
      await until(async () => scheduled(await h.fetchHistory()).includes('fetch_tickets'), 'the first task');
      await until(async () => (await stateOf(h)).state.briefState !== 'gathering', 'the forged timer', 60).catch(() => null);
      const s = await stateOf(h);
      assert.equal(s.state.briefState, 'gathering', `a forged timer completed the fetch order: ticketCount ${s.state.ticketCount}`);
    });
  } finally {
    p.gate.open = true;
    await terminate(id);
  }
});

// RP1 (blocker) — review S1 again, through `polyflow.report`. The report
// validator checks only that the order is open and, if claimed, who holds it.
// An unclaimed order addressed to a person (performer: human) is answered by
// anyone with an Update: the human's parked activity is cancelled, the brief
// is posted, and nobody approved it.
test('RP1: an order addressed to a person cannot be reported by an unidentified caller', async () => {
  const p = parkable();
  const w = await makeWorker('rv45-rp1', p.activities);
  let wid;
  try {
    await w.runUntil(async () => {
      const { handle: h, workflowId } = await startGoverned(env.client, { descriptor, input: { date: '2031-01-01' }, taskQueue: 'rv45-rp1', workflowExecutionTimeout: '60s' });
      wid = workflowId;
      const s = await until(async () => { const x = await stateOf(h); return x.state.briefState === 'review' && x.orders.length ? x : null; }, 'review');
      assert.equal(s.orders[0].role, 'human');
      const r = await h.executeUpdate('polyflow.report', { args: [{ orderId: s.orders[0].orderId, ok: true, result: {} }] }).then((x) => x, (e) => ({ refused: msg(e) }));
      await new Promise((res) => setTimeout(res, 500));
      assert.ok(r.refused, `the report was accepted (${JSON.stringify(r).slice(0, 120)}); posts: ${p.gate.posts}`);
      assert.equal(p.gate.posts, 0);
    });
  } finally {
    p.gate.open = true;
    if (wid) await terminate(wid);
  }
});

// RL1 (major) — the claim validator checks the role only when the caller
// supplies `actor.roles`; an actor without roles claims any order.
test('RL1: a claim on a role-addressed order needs the role', async () => {
  const w = await makeWorker('rv45-rl1', {});
  const id = 'rv45-rl1-run';
  try {
    await w.runUntil(async () => {
      const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'rv45-rl1', workflowId: id, workflowExecutionTimeout: '60s', args: [{ machine: 'customer-brief', input: {}, mode: 'external' }] });
      const s = await toReview(h);
      assert.equal(s.orders[0].role, 'human');
      const r = await h.executeUpdate('polyflow.claim', { args: [{ orderId: s.orders[0].orderId, actor: { id: 'mallory' } }] }).then((x) => x, (e) => ({ claimed: false, refused: msg(e) }));
      assert.equal(r.claimed, false, 'an actor with no roles claimed the human approval');
    });
  } finally {
    await terminate(id);
  }
});

// PC1 (major) — "only the holder may report" (FR-HUM.2) holds for
// polyflow.report, not for polyflow.propose: outOfBand() checks that the
// order is open, never who holds it.
test('PC1: a claimed order cannot be completed by someone else through propose', async () => {
  const w = await makeWorker('rv45-pc1', {});
  const id = 'rv45-pc1-run';
  try {
    await w.runUntil(async () => {
      const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'rv45-pc1', workflowId: id, workflowExecutionTimeout: '60s', args: [{ machine: 'customer-brief', input: {}, mode: 'external' }] });
      const s = await until(async () => { const x = await stateOf(h); return x.orders.length ? x : null; }, 'the fetch order');
      const orderId = s.orders[0].orderId;
      const c = await h.executeUpdate('polyflow.claim', { args: [{ orderId, actor: { id: 'alice', roles: ['agent'] } }] });
      assert.equal(c.claimed, true);
      const r = await h.executeUpdate('polyflow.propose', { args: [{ action: 'TICKETS_READY', data: { count: 3 }, orderId }] }).then((x) => x, (e) => ({ refused: msg(e) }));
      assert.ok(r.refused, `alice holds the order, yet a propose completed it: ${JSON.stringify(r).slice(0, 120)}`);
    });
  } finally {
    await terminate(id);
  }
});

// MG1 (blocker) — polyflow.migrate validates nothing but "is an object": no
// contract shape, no invariants, no principal, no link to a gate decision.
// The run then continues as new, and the next execution refuses the snapshot
// with a non-retryable failure: one Update, from anyone, fails the run.
test('MG1: a migration the machine cannot hold is refused before the run hands over', async () => {
  const w = await makeWorker('rv45-mg1', {});
  const id = 'rv45-mg1-run';
  try {
    await w.runUntil(async () => {
      const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'rv45-mg1', workflowId: id, workflowExecutionTimeout: '60s', args: [{ machine: 'customer-brief', input: {}, mode: 'external' }] });
      await until(async () => (await stateOf(h)).orders.length, 'the fetch order');
      const r = await h.executeUpdate('polyflow.migrate', { args: [{ snapshot: { briefState: 'gathering', ticketCount: 0, reason: '', addedInV3: true } }] })
        .then(() => 'accepted', (e) => `refused: ${msg(e)}`);
      let status = 'RUNNING';
      if (r === 'accepted') status = await until(async () => { const d = await env.client.workflow.getHandle(id).describe(); return d.status.name !== 'RUNNING' ? d.status.name : null; }, 'the run to close', 100).catch(() => 'RUNNING');
      assert.match(r, /^refused/, `the migration was accepted and the run is now ${status}`);
    });
  } finally {
    await terminate(id);
  }
});

// MG2 (major) — the migrate Update carries no "from" state. The gate
// snapshots a run, the run moves on, and the gate's migrated (old) state
// overwrites the progress: here an approved run is put back into drafting.
test('MG2: a migration computed from a state the run has left does not rewind it', async () => {
  const w = await makeWorker('rv45-mg2', {});
  const id = 'rv45-mg2-run';
  try {
    await w.runUntil(async () => {
      const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'rv45-mg2', workflowId: id, workflowExecutionTimeout: '60s', args: [{ machine: 'customer-brief', input: {}, mode: 'external' }] });
      const s = await until(async () => { const x = await stateOf(h); return x.orders.length ? x : null; }, 'fetch');
      await h.executeUpdate('polyflow.report', { args: [{ orderId: s.orders[0].orderId, ok: true, result: { count: 3 } }] });
      const snapshot = (await until(async () => { const x = await stateOf(h); return x.state.briefState === 'drafting' ? x : null; }, 'drafting')).state; // the gate's fleet read
      const d = (await stateOf(h)).orders[0];
      await h.executeUpdate('polyflow.report', { args: [{ orderId: d.orderId, ok: true, result: {} }] }); // the run moves on to review
      await h.executeUpdate('polyflow.migrate', { args: [{ snapshot }] }).catch(() => null); // the gate applies its decision
      const after = await until(async () => { const x = await env.client.workflow.getHandle(id).query('polyflow.state'); return x.seq !== undefined ? x : null; }, 'the next execution');
      await new Promise((r) => setTimeout(r, 300));
      const now = await env.client.workflow.getHandle(id).query('polyflow.state');
      assert.equal(now.state.briefState, 'review', `the run was rewound to '${now.state.briefState}' (seq ${after.seq})`);
    });
  } finally {
    await terminate(id);
  }
});

// CL1 (major) — claims are not carried across Continue-as-New: handOver()
// carries { intentId, kind, payload, attempt } only. After a hand-over the
// holder's lease is gone and anyone reports the order.
test('CL1: a claim survives Continue-as-New', async () => {
  const w = await makeWorker('rv45-cl1', {});
  const id = 'rv45-cl1-run';
  try {
    await w.runUntil(async () => {
      const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'rv45-cl1', workflowId: id, workflowExecutionTimeout: '60s', args: [{ machine: 'customer-brief', input: {}, mode: 'external' }] });
      const s = await until(async () => { const x = await stateOf(h); return x.orders.length ? x : null; }, 'fetch');
      const orderId = s.orders[0].orderId;
      await h.executeUpdate('polyflow.claim', { args: [{ orderId, actor: { id: 'alice', roles: ['agent'] } }] });
      const first = h.firstExecutionRunId;
      // any hand-over: an identity migration forces one (it names the state it was computed from: review MG2)
      await h.executeUpdate('polyflow.migrate', { args: [{ snapshot: s.state, from: digest(s.state) }] });
      const g = env.client.workflow.getHandle(id);
      await until(async () => (await g.describe()).runId !== first && (await g.query('polyflow.state')).orders.length, 'the next execution');
      const r = await g.executeUpdate('polyflow.report', { args: [{ orderId, ok: true, result: { count: 3 }, actor: { id: 'bob' } }] }).then((x) => x, (e) => ({ refused: msg(e) }));
      assert.ok(r.refused, `alice's claim was dropped at the hand-over and bob reported her order: ${JSON.stringify(r).slice(0, 120)}`);
    });
  } finally {
    await terminate(id);
  }
});

// GC1 (major) — tech spec §4.1: the guard state "round-trips through
// Continue-as-New". It does not: the next execution builds a fresh governor
// (guard.init()); only the ledger head is handed over. Every counter, budget,
// taint and unconsumed approval resets at each hand-over — and GovernedWorkflow
// now hands over on `continueAsNewSuggested` and on any polyflow.migrate.
test('GC1: at-most-one-post still holds after Continue-as-New', async () => {
  const policy = {
    policy: 'review-gc1', version: 1,
    effects: { slack_send: { kind: 'post', class: 'irreversible', labels: ['egress'] }, ask_approval: { kind: 'approval', class: 'none' } },
    rules: [
      { id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' },
      { id: 'at-most-one-post', type: 'at-most', guards: 'post', n: 1 },
    ],
  };
  let posts = 0;
  const w = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'rv45-gc1', workflowsPath: `${fixtures}review-p4p5-workflows.mjs`, maxCachedWorkflows: 0,
    bundlerOptions: { logger: quiet },
    activities: { ask_approval: async () => ({}), slack_send: async () => { posts += 1; return {}; } },
    plugins: [new PolyflowPlugin({ level: 'guard', policy, sink: memorySink() })],
  });
  const r = await w.runUntil(env.client.workflow.execute('postAcrossContinueAsNew', { taskQueue: 'rv45-gc1', workflowId: 'rv45-gc1-run', args: [{}], workflowExecutionTimeout: '60s' }));
  assert.equal(r.secondPost, 'denied', `the run posted ${posts} times under at-most-one-post`);
});
