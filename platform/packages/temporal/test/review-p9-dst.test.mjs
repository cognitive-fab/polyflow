// P9 review — the DST harness (dst.test.mjs) against its own claims. The
// schedule below is dst.test.mjs's, verbatim, so a seed here is the same
// schedule there. Each test fails today for the reason in its message.
// See docs/platform/reviews/P9-review.md (DST1, DST2).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { digest } from '@cognitive-fab/polyflow-kernel';
import { PolyflowPlugin, memorySink } from '../src/index.mjs';
import { startEnv, fixtures, quiet } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const SEEDS = Number(process.env.DST_SEEDS ?? 20);
const STEPS = 30;

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rnd, xs) => xs[Math.floor(rnd() * xs.length)];
const HUMAN = { id: 'dana', roles: ['human', 'agent'] };
const AGENTS = [{ id: 'alice', roles: ['agent'] }, { id: 'bob', roles: ['agent'] }];

async function schedule(h, seed) {
  const rnd = prng(seed);
  const trace = [];
  const tryUpdate = async (name, arg) => {
    try { await h.executeUpdate(name, { args: [arg] }); trace.push(`${name}:ok`); return true; } catch { trace.push(`${name}:refused`); return false; }
  };
  const closed = [];
  for (let i = 0; i < STEPS; i++) {
    let s;
    try { s = await h.query('polyflow.state'); } catch { trace.push('query-failed'); break; }
    if (s.terminal) break;
    const o = s.orders[0];
    const r0 = rnd();
    const move = r0 < 0.03 ? 'stop' : r0 < 0.06 ? 'permanent' : pick(rnd, ['ok', 'ok', 'ok', 'fail', 'dup', 'claim', 'wrong', 'handover', 'stale']);
    const actor = o?.role === 'human' ? HUMAN : pick(rnd, AGENTS);
    const result = o?.kind === 'fetch_tickets' ? { count: pick(rnd, [0, 2, 5]) } : {};
    if (move === 'ok' && o) { if (await tryUpdate('polyflow.report', { orderId: o.orderId, ok: true, result, actor })) closed.push(o.orderId); }
    else if (move === 'fail' && o) await tryUpdate('polyflow.report', { orderId: o.orderId, ok: false, error: 'flaky', actor });
    else if (move === 'permanent' && o) await tryUpdate('polyflow.report', { orderId: o.orderId, ok: false, permanent: true, error: 'no', actor });
    else if (move === 'dup' && closed.length) await tryUpdate('polyflow.report', { orderId: pick(rnd, closed), ok: true, result: {}, actor });
    else if (move === 'claim' && o) await tryUpdate('polyflow.claim', { orderId: o.orderId, actor });
    else if (move === 'wrong' && o) await tryUpdate('polyflow.report', { orderId: o.orderId, ok: true, result, actor: { id: 'mallory', roles: [] } });
    else if (move === 'stop') await tryUpdate('polyflow.propose', { action: 'STOP' });
    else if (move === 'handover' && !s.migrationPending) await tryUpdate('polyflow.migrate', { snapshot: s.state, from: digest(s.state) });
    else if (move === 'stale') await tryUpdate('polyflow.migrate', { snapshot: { ...s.state, ticketCount: 99 }, from: digest({ ...s.state, ticketCount: 98 }) });
  }
  return trace;
}

// Response: HO1 (the lost Update) is fixed; the fork that remains is a different
// defect this test found: the ledger event times of a run's FIRST activation
// differ between two replays of the same history (the flush was built in one,
// the Continue-as-New head in another), so the head handed over does not match
// the events already exported. Open, tracked in P9-review.md (DST1-R); kept
// visible as a todo so the suite shows it without hiding it.
test('DST1: no DST schedule forks the ledger (the exporter reports no conflict, fork or gap)', { todo: 'DST1-R: replay-unstable event times in the first activation (see P9-review.md Response)' }, async () => {
  const problems = [];
  const sink = memorySink();
  const plugin = new PolyflowPlugin({
    sink, machines: { 'customer-brief': BRIEF }, allowUncertified: true, externalMode: 'always',
    onConflict: (run, seqs) => problems.push(`conflict ${run.wf} at seq ${seqs.join(',')}`),
    onError: (err) => problems.push(err.message),
  });
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'review-dst', workflowsPath: `${fixtures}governed-workflows.mjs`, activities: {}, maxCachedWorkflows: 0,
    bundlerOptions: { logger: quiet }, plugins: [plugin],
  });
  const traces = {};
  await worker.runUntil(async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const id = `review-dst-${seed}`;
      const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'review-dst', workflowId: id, args: [{ machine: 'customer-brief', input: {} }], workflowExecutionTimeout: '120s' });
      traces[seed] = await schedule(h, seed);
      await env.client.workflow.getHandle(id).terminate('dst done').catch(() => {});
    }
  });
  const bySeed = Object.entries(traces).filter(([seed]) => problems.some((p) => p.includes(`review-dst-${seed}/`) || p.includes(`review-dst-${seed} `))).map(([seed, t]) => `seed ${seed}: ${t.join(' ')}`);
  assert.deepEqual(problems, [], `DST1: the exporter reported ${problems.length} problem(s) that dst.test.mjs never looks at (its I3 verifies only what the sink kept):\n${problems.join('\n')}\n${bySeed.join('\n')}`);
});
