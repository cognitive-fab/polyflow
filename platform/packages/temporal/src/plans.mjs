// Plans as proposals, inside a workflow — FR-PLAN.1–.4; technical spec §9.2.
//
// An agent's workflow code calls `proposePlan(plan)`. The plan is checked
// against the run's policy from the run's CURRENT guard state — every order
// the plan permits, before any step runs — and the verdict is recorded in the
// ledger. An admitted plan is then run step by step, each step still crossing
// the guard at run time: admission says the plan CAN'T break the rules; the
// guard makes sure it doesn't.
//
// Admission is pure, so it runs inline in workflow code: no activity, no
// billable Action, and the same verdict on every replay. It walks the plan's
// down-sets, not its orders, under a declared budget of guard evaluations, so
// it stays well inside a workflow task (P6-P8 review TP3).
//
// The executor runs the plan in its own cancellation scope. The first step
// that fails cancels every other step of the plan before proposePlan reports
// the failure, so nothing of a failed plan runs after the agent was told
// (review TP1). Every step's effect carries the same argument digest the plan
// named (TP2), and the plan's outcome is recorded: completed, or failed at a
// step, with the steps that ran.

import { proxyActivities, workflowInfo, ApplicationFailure, CancellationScope, isCancellation } from '@temporalio/workflow';
import { parsePlan, admitPlan, stepArgsDigest } from '@cognitive-fab/polyflow-kernel';
import { governorOf } from './governor-registry.mjs';

/**
 * @param {{steps: {id, activity, args?, after?}[]}} raw
 * @param {object} [o]
 * @param {boolean} [o.run]  run the plan if admitted (default true)
 * @param {object} [o.activityOptions]
 * @returns {Promise<{ verdict, escalations, witness?, results? }>}
 */
export async function proposePlan(raw, { run = true, activityOptions = { startToCloseTimeout: '1 minute', retry: { maximumAttempts: 3 } } } = {}) {
  const g = governorOf(workflowInfo().runId);
  if (!g?.governor?.policy) {
    throw ApplicationFailure.nonRetryable('plans are checked against a policy: this worker runs no PolyflowPlugin at level "guard"', 'PolyflowNoPolicy');
  }
  // A bad plan fails the CALL, never the workflow task: an error escaping here
  // would be retried forever and wedge the run (P9 security SEC-PL1).
  let plan;
  let verdict;
  try {
    plan = parsePlan(raw);
    verdict = admitPlan(g.governor.policy, plan, { state: g.governor.state(), at: Date.now() });
  } catch (err) {
    throw ApplicationFailure.nonRetryable(`plan refused: ${err?.message ?? err}`, 'PolyflowPlanRefused');
  }
  const proposal = g.record('proposal', { source: 'agent', action: 'plan', planDigest: plan.digest, steps: plan.steps.map((s) => ({ id: s.id, activity: s.activity, argsDigest: stepArgsDigest(s), after: s.after, ...(s.maxSpend ? { maxSpend: s.maxSpend } : {}) })) });
  g.record('verdict', {
    // The verdict names its proposal by seq, like every other verdict (P6-P8 review minor).
    proposal: proposal ? `p${proposal.seq}` : 'plan', outcome: verdict.verdict === 'admitted' ? 'accepted' : 'rejected', rules: verdict.witness?.rules ?? [],
    planDigest: plan.digest, escalations: verdict.escalations, ...(verdict.witness ? { witness: verdict.witness } : {}), ...(verdict.reason ? { reason: verdict.reason } : {}),
  });
  if (verdict.verdict !== 'admitted' || !run) return verdict;

  // Run it: each step starts when the steps it comes after have finished.
  const acts = proxyActivities(activityOptions);
  const done = new Map();
  const running = new Map();
  let failed = null;
  const scope = new CancellationScope();
  const start = (s) => {
    if (!running.has(s.id)) {
      running.set(s.id, (async () => {
        for (const a of s.after) await start(plan.steps.find((x) => x.id === a));
        try {
          const r = await acts[s.activity](s.args);
          done.set(s.id, r);
          return r;
        } catch (err) {
          // The first real failure stops the whole plan; the cancellations it
          // causes in the other branches are not failures of their own.
          if (!failed && !isCancellation(err)) { failed = { step: s.id, error: err }; scope.cancel(); }
          throw err;
        }
      })());
    }
    return running.get(s.id);
  };
  try {
    await scope.run(() => Promise.allSettled(plan.steps.map(start)));
  } finally {
    const outcome = failed ? 'failed' : 'completed';
    g.record('observation', {
      effect: `plan:${plan.digest}`, ok: !failed, outcome, planDigest: plan.digest,
      ran: [...done.keys()], ...(failed ? { failedAt: failed.step, cancelled: plan.steps.map((s) => s.id).filter((id) => !done.has(id) && id !== failed.step) } : {}),
    });
  }
  if (failed) throw failed.error;
  return { ...verdict, results: Object.fromEntries(done) };
}
