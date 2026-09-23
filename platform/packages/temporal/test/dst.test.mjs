// P9 — deterministic simulation over governed runs. Each seed draws a schedule
// of what the outside world does to an external-mode run of customer-brief:
// reports that succeed, fail, fail for good, or arrive twice; claims by two
// agents and reports by the wrong one; STOP; a hand-over forced by an identity
// migration (Continue-as-New), sometimes computed from a state the run has
// already left. The schedule is a pure function of the seed; a failing seed
// reproduces as long as the system's own behaviour is deterministic, which is
// what this harness exists to check (P9 review N3).
//
// Scope, stated plainly (P9 review DST): the stimuli are sequential, not
// concurrent; I1 and I5 read the journal of the LAST execution; I3 checks the
// chain the sink kept. The exporter's own conflict/fork signals are checked by
// review-p9-dst.test.mjs, which still finds one open defect (DST1-R).
//
// After every schedule, whatever happened, these must hold:
//   I1  the brief is posted at most once;
//   I2  the run's state is one the machine can hold (checkSnapshot);
//   I3  the ledger is one hash chain across every execution, and verifies;
//   I4  every execution's history replays with zero non-determinism;
//   I5  no refused Update left a trace: the journal's accepted steps are exactly
//       what the machine accepted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { verifyChain, createHost, digest } from '@cognitive-fab/polyflow-kernel';
import { PolyflowPlugin, memorySink } from '../src/index.mjs';
import { startEnv, fixtures, quiet } from './helpers.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

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

const plugin = (sink) => new PolyflowPlugin({ sink, machines: { 'customer-brief': BRIEF }, allowUncertified: true, externalMode: 'always' });

/** The same machine, hosted outside Temporal, to check what the run's journal claims. */
function hostFor() {
  const req = createRequire(`${BRIEF}x.cjs`);
  const contract = JSON.parse(readFileSync(`${BRIEF}contract.json`, 'utf-8'));
  return createHost({ module: req(`${BRIEF}machine.cjs`), contract, mapper: req(`${BRIEF}effects.cjs`).effects });
}

async function schedule(h, seed) {
  const rnd = prng(seed);
  const trace = [];
  const tryUpdate = async (name, arg) => {
    try { await h.executeUpdate(name, { args: [arg] }); trace.push(`${name}:ok`); return true; } catch { trace.push(`${name}:refused`); return false; }
  };
  const closed = [];
  for (let i = 0; i < STEPS; i++) {
    let s;
    try { s = await h.query('polyflow.state'); } catch { break; }
    if (s.terminal) break;
    const o = s.orders[0];
    // The run-ending moves are rare, so a schedule lives long enough to meet the others.
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

test(`DST: ${SEEDS} seeded schedules of the outside world against a governed run`, async () => {
  const sink = memorySink();
  const host = hostFor();
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'dst', workflowsPath: `${fixtures}governed-workflows.mjs`, activities: {}, maxCachedWorkflows: 0,
    bundlerOptions: { logger: quiet }, plugins: [plugin(sink)],
  });
  const results = [];
  await worker.runUntil(async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const id = `dst-${seed}`;
      const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'dst', workflowId: id, args: [{ machine: 'customer-brief', input: {} }], workflowExecutionTimeout: '120s' });
      const trace = await schedule(h, seed);
      const g = env.client.workflow.getHandle(id);
      const s = await g.query('polyflow.state').catch(() => null);
      const journal = await g.query('polyflow.journal').catch(() => []);
      await g.terminate('dst done').catch(() => {});
      results.push({ seed, id, trace, state: s?.state, journal });
    }
  });

  const replayWorker = { workflowsPath: `${fixtures}governed-workflows.mjs`, bundlerOptions: { logger: quiet }, plugins: [plugin(memorySink())] };
  for (const r of results) {
    const where = `seed ${r.seed} (${r.trace.join(' ')})`;
    // I1
    const posts = r.journal.filter((j) => j.action === 'POST_DONE' && j.stepKind === 'accepted').length;
    assert.ok(posts <= 1, `I1 ${where}: posted ${posts} times`);
    // I2
    if (r.state) assert.equal(host.checkSnapshot(r.state), null, `I2 ${where}`);
    // I5: every accepted step in the journal is one the machine accepts from the journal's own pre-state.
    for (const j of r.journal.filter((x) => x.stepKind === 'accepted' && x.pre && x.action && !x.action.startsWith('polyflow.'))) {
      const d = host.dryRun(j.pre, j.action, j.data ?? {});
      assert.equal(d.stepKind, 'accepted', `I5 ${where}: journal says ${j.action} was accepted from ${JSON.stringify(j.pre)}`);
    }
    // I4: replay every execution in the chain.
    const runs = [];
    for await (const w of env.client.workflow.list({ query: `WorkflowId = '${r.id}'` })) runs.push(w.runId);
    for (const runId of runs) {
      const history = await env.client.workflow.getHandle(r.id, runId).fetchHistory();
      await Worker.runReplayHistory({ ...replayWorker, replayName: `${r.id}-${runId}` }, history, r.id);
    }
  }
  // I3: one chain per workflow, whatever the hand-overs.
  const byWf = new Map();
  for (const run of sink.runs()) byWf.set(run.wf, [...(byWf.get(run.wf) ?? []), run]);
  for (const [wf, chains] of byWf) {
    assert.equal(chains.length, 1, `I3 ${wf}: ${chains.length} chains`);
    assert.equal(verifyChain(sink.read(chains[0]).events).ok, true, `I3 ${wf}`);
  }
  const handovers = results.reduce((n, r) => n + r.trace.filter((t) => t === 'polyflow.migrate:ok').length, 0);
  const refused = results.reduce((n, r) => n + r.trace.filter((t) => t.endsWith(':refused')).length, 0);
  console.log(`[DST] ${JSON.stringify({ seeds: SEEDS, stimuli: results.reduce((n, r) => n + r.trace.length, 0), refused, handovers, posted: results.filter((r) => r.state?.briefState === 'posted').length })}`);
  assert.ok(handovers > 0, 'the schedules exercised Continue-as-New');
});
