// Plans as proposals — FR-PLAN.1–.4; technical spec §9.2.
//
// An agent may author a plan at run time: a set of steps, each an effect with
// arguments, and the steps each must come after. The platform decides whether
// the plan may run BEFORE any step runs, by checking every order in which the
// plan could execute against the run's policy:
//
//   admitted     every linearisation of the plan's partial order is allowed by
//                the guard at every step (effects assumed to succeed)
//   needs        some steps will escalate: the plan may run, and those steps
//                will ask a person when they are reached
//   refused      some linearisation reaches a step the guard DENIES; the
//                witness is that order and that step
//
// The check is the guard itself, run over each order from the run's CURRENT
// guard state — so a plan's authority is the parent's remaining authority by
// construction: it cannot order a kind the parent could not, or spend a budget
// the parent has already spent (FR-PLAN.4).
//
// Orders are not enumerated one by one. The walk is over the plan's DOWN-SETS
// (which steps are done), memoised on (down-set, guard state): two orders that
// reach the same steps done with the same guard state have the same future, so
// it is checked once. Two independent chains of 7 are 3,432 orders but at most
// 64 down-sets (P6-P8 review TP3). The bound is a declared budget of guard
// evaluations (FR-PLAN.3); a plan that needs more is `bounded`, never admitted.
//
// What "admitted" means, exactly: on the path where every step succeeds, no
// step is denied by the RULES. A metered budget (usd, tokens) can only be
// checked if each step declares the most it may spend (`maxSpend`); a plan
// that leaves a metered budget unbounded is refused (review PL, KP1). A step
// can still fail, be rejected by a person, or be stopped by a signal: the
// executor handles that, and the guard still decides every step at run time.

import { createGuard } from './rules.mjs';
import { classify, routeTarget } from './policy.mjs';
import { digest } from './digest.mjs';
import { canonical } from './canonical.mjs';

export class PlanError extends Error {
  constructor(message) { super(message); this.name = 'PlanError'; }
}

/** What an agent-authored plan may be: bounded, so checking it is bounded (P9 security SEC-PL1/PL2). */
export const PLAN_LIMITS = Object.freeze({ maxSteps: 256, maxArgsChars: 65_536 });

/** Validate a step list: unique ids, known `after` references, no cycles, within PLAN_LIMITS. */
export function parsePlan(raw) {
  if (!raw || !Array.isArray(raw.steps) || raw.steps.length === 0) throw new PlanError('a plan has at least one step');
  if (raw.steps.length > PLAN_LIMITS.maxSteps) throw new PlanError(`a plan has at most ${PLAN_LIMITS.maxSteps} steps; this one has ${raw.steps.length}: split it`);
  let argsChars = 0;
  const ids = new Set();
  const steps = raw.steps.map((s, i) => {
    if (typeof s.id !== 'string' || !s.id) throw new PlanError(`steps[${i}]: needs an id`);
    if (ids.has(s.id)) throw new PlanError(`steps[${i}]: duplicate id '${s.id}'`);
    ids.add(s.id);
    if (typeof s.activity !== 'string' || !s.activity) throw new PlanError(`step '${s.id}': needs the activity it runs`);
    if (s.maxSpend !== undefined && (typeof s.maxSpend !== 'object' || s.maxSpend === null || Object.values(s.maxSpend).some((v) => !Number.isFinite(v) || v < 0))) {
      throw new PlanError(`step '${s.id}': maxSpend maps a metric to a non-negative number, e.g. { "usd": 0.6 }`);
    }
    let text;
    try { text = canonical(s.args ?? {}); } catch (err) { throw new PlanError(`step '${s.id}': args are not canonical JSON (${err.message})`); }
    argsChars += text.length;
    if (argsChars > PLAN_LIMITS.maxArgsChars) throw new PlanError(`a plan's arguments total at most ${PLAN_LIMITS.maxArgsChars} characters: pass large content by reference`);
    return { id: s.id, activity: s.activity, args: s.args ?? {}, after: [...new Set(s.after ?? [])], ...(s.maxSpend ? { maxSpend: s.maxSpend } : {}) };
  });
  for (const s of steps) for (const a of s.after) if (!ids.has(a)) throw new PlanError(`step '${s.id}' comes after unknown step '${a}'`);
  // cycle check (Kahn), linear in steps + edges
  const indeg = new Map(steps.map((s) => [s.id, s.after.length]));
  const children = new Map(steps.map((s) => [s.id, []]));
  for (const s of steps) for (const a of s.after) children.get(a).push(s.id);
  const queue = steps.filter((s) => s.after.length === 0).map((s) => s.id);
  let seen = 0;
  for (let q = 0; q < queue.length; q++) {
    seen++;
    for (const c of children.get(queue[q])) { indeg.set(c, indeg.get(c) - 1); if (indeg.get(c) === 0) queue.push(c); }
  }
  if (seen !== steps.length) throw new PlanError('the plan has a cycle: some step comes after itself');
  return { steps, digest: digest({ steps }) };
}

/** The digest a step's effect will carry: the activity's argument LIST, as the interceptor digests it (review TP2). */
export const stepArgsDigest = (step) => digest(JSON.parse(JSON.stringify([step.args ?? {}])));

/** A result object carrying `value` at a dotted path, as a metered budget reads it. */
function resultAt(result, path, value) {
  const keys = String(path).split('.');
  let o = result;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
  const last = keys[keys.length - 1];
  o[last] = (o[last] ?? 0) + value;
  return result;
}

class Bounded extends Error {}

/**
 * Check a plan against a policy from a guard state.
 * @param {object} policy      an admitted policy (admitPolicy)
 * @param {object} plan        parsePlan(...)
 * @param {object} [o]
 * @param {object} [o.state]   the run's current guard state (default: a fresh run)
 * @param {number} [o.at]      workflow time the plan would start at
 * @param {number} [o.maxEvaluations]  the exploration budget, in guard decisions
 * @returns {{ verdict: 'admitted'|'refused'|'bounded', escalations: string[], witness?, statesChecked, reason? }}
 */
export function admitPlan(policy, plan, { state = null, at = 0, maxEvaluations = 20_000 } = {}) {
  const guard = createGuard(policy);
  const steps = plan.steps;
  const kinds = steps.map((st) => classify(policy, routeTarget(policy, st.activity, [st.args])));

  // A metered budget the plan could overrun is not a rule the check can see
  // unless every step it meters says how much it may spend.
  const metered = (policy.rules ?? []).filter((r) => r.type === 'budget' && r.metric !== 'effects');
  for (const [i, st] of steps.entries()) {
    for (const r of metered) {
      if (r.kinds && !r.kinds.includes(kinds[i].kind)) continue;
      if (!Number.isFinite(st.maxSpend?.[r.metric])) {
        const message = `step '${st.id}' is metered by budget '${r.id}' (${r.metric}) but declares no maxSpend.${r.metric}: the plan's cost is not bounded by the budget`;
        return { verdict: 'refused', escalations: [], statesChecked: 0, reason: message, witness: { order: [], step: st.id, activity: st.activity, rules: [r.id], message, allowedNow: [] } };
      }
    }
  }
  const spendOf = (i) => {
    const result = {};
    for (const r of metered) if (!r.kinds || r.kinds.includes(kinds[i].kind)) resultAt(result, r.from, steps[i].maxSpend[r.metric]);
    return result;
  };

  const argsDigests = steps.map((st) => stepArgsDigest(st)); // once per step, not per evaluation (SEC-PL2)
  const index = new Map(steps.map((st, i) => [st.id, i]));
  const needs = steps.map((st) => st.after.map((a) => index.get(a)));
  const escalations = new Set();
  const seen = new Set();
  let evaluations = 0;

  /** A full order for the witness: the path taken, the failing step, then the rest in plan order. */
  const witnessOrder = (path, i) => {
    const out = [...path, i];
    const done = new Set(out);
    let progress = true;
    while (progress) {
      progress = false;
      for (let j = 0; j < steps.length; j++) {
        if (!done.has(j) && needs[j].every((n) => done.has(n))) { out.push(j); done.add(j); progress = true; }
      }
    }
    return out.map((j) => steps[j].id);
  };

  // Depth-first over down-sets with an explicit stack: an agent's chain of
  // hundreds of steps must not overflow the isolate's call stack (SEC-PL1).
  const walk = (done0, s0, t0) => {
    const stack = [{ done: done0, s: s0, t: t0, path: [], i: 0, entered: false }];
    while (stack.length) {
      const f = stack[stack.length - 1];
      if (!f.entered) {
        f.entered = true;
        if (f.path.length === steps.length) { stack.pop(); continue; }
        const key = `${f.done.join('')}|${canonical(f.s)}`;
        if (seen.has(key)) { stack.pop(); continue; }
        seen.add(key);
      }
      let pushed = false;
      for (; f.i < steps.length; f.i++) {
        const i = f.i;
        if (f.done[i] || !needs[i].every((n) => f.done[n])) continue;
        if (++evaluations > maxEvaluations) throw new Bounded();
        const st = steps[i];
        const cls = kinds[i];
        const c = { ...cls, labels: cls.labels ?? [], target: st.activity, argsDigest: argsDigests[i], at: f.t + 1, proposal: `plan:${st.id}` };
        let s1 = f.s;
        let d = guard.decide(s1, c);
        if (d.outcome === 'escalate') {
          // A person will be asked when the step is reached; for the check, assume yes.
          escalations.add(st.id);
          s1 = guard.grant(s1, { id: `plan-approval:${st.id}`, kind: c.kind, argsDigest: c.argsDigest, proposal: c.proposal, at: f.t + 1 });
          d = guard.decide(s1, c);
        }
        if (d.outcome !== 'allow') {
          return { order: witnessOrder(f.path, i), step: st.id, activity: st.activity, rules: d.rules, message: d.message, allowedNow: d.witness?.allowedNow ?? [] };
        }
        const s2 = guard.observe(guard.commit(s1, c, d), { kind: c.kind, ok: true, result: spendOf(i) });
        const next = f.done.slice();
        next[i] = 1;
        f.i++;
        stack.push({ done: next, s: s2, t: f.t + 1, path: [...f.path, i], i: 0, entered: false });
        pushed = true;
        break;
      }
      if (!pushed) stack.pop();
    }
    return null;
  };

  try {
    const witness = walk(steps.map(() => 0), state ?? guard.init(), at);
    if (witness) return { verdict: 'refused', escalations: [...escalations].sort(), statesChecked: seen.size, witness };
  } catch (err) {
    if (!(err instanceof Bounded)) throw err;
    return { verdict: 'bounded', escalations: [], statesChecked: seen.size, reason: `more than ${maxEvaluations} guard evaluations: the plan cannot be checked exhaustively within its budget; split it or add ordering` };
  }
  return { verdict: 'admitted', escalations: [...escalations].sort(), statesChecked: seen.size };
}
