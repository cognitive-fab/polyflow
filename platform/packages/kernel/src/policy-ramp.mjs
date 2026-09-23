// Policy ramp gate — plan P4.6; the G1 counterpart of fleet-gated versioning.
//
// A policy is part of the worker build, so changing it is a deployment. At
// G2 the version gate vets a new MACHINE against the live fleet; at G1 there
// is no machine, but every run carries its guard state. This asks, for each
// run in flight: is there an ACTIVITY the run may call right now under the
// policy it started with, that the new policy would deny it from the same
// state? Such a run was promised something the new policy takes back, so it
// is pinned to workers carrying the old policy; every other run may move.
//
// What is compared (P9 review RP1–RP4):
//   - every activity either policy declares, classified under EACH policy
//     (an activity that changes kind is compared as an activity, not a kind);
//   - an undeclared activity, when the old policy let one through
//     (`unlabelled: report|escalate`) and the new one does not;
//   - the run's state CARRIED into the new policy: a new budget or rate rule
//     over the same metric starts from what the run already spent under the
//     old one, not from zero (a renamed, tightened budget is a tightening).
// `freshRules` lists the rules whose counters genuinely start from zero under
// the new policy (a new consuming requires-prior, a budget over a metric the
// old policy never metered): a decision somebody should see.
//
// Pure.

import { createGuard } from './rules.mjs';
import { classify } from './policy.mjs';

const UNDECLARED = '\u0000undeclared-activity';

/** The run's guard state, re-keyed for the new policy's rules where the old policy counted the same thing. */
function carryState(oldPolicy, newPolicy, state) {
  const s = JSON.parse(JSON.stringify(state));
  const oldIds = new Set(oldPolicy.rules.map((r) => r.id));
  const fresh = [];
  for (const r of newPolicy.rules) {
    if (oldIds.has(r.id)) continue;
    if (r.type === 'budget') {
      const same = oldPolicy.rules.filter((o) => o.type === 'budget' && o.metric === r.metric && (r.metric === 'effects' || o.from === r.from)
        && (!r.kinds || !o.kinds || o.kinds.some((k) => r.kinds.includes(k))));
      if (same.length) s.meters[r.id] = Math.max(0, ...same.map((o) => state.meters?.[o.id] ?? 0));
      else if (r.metric === 'effects') s.meters[r.id] = Object.entries(state.n ?? {}).filter(([k]) => !r.kinds || r.kinds.includes(k)).reduce((a, [, v]) => a + v, 0);
      else fresh.push(r.id);
    } else if (r.type === 'rate') {
      const same = oldPolicy.rules.filter((o) => o.type === 'rate' && o.guards === r.guards);
      if (same.length) s.rate[r.id] = [...new Set(same.flatMap((o) => state.rate?.[o.id] ?? []))].sort((a, b) => a - b);
      else fresh.push(r.id);
    } else if (r.type === 'requires-prior' && r.consume) {
      fresh.push(r.id); // credits are counted per rule, from when the rule exists
    }
  }
  return { state: s, fresh };
}

/**
 * @param {object} oldPolicy  admitted
 * @param {object} newPolicy  admitted
 * @param {{ workflowId: string, guard: object, at: number }[]} fleet
 * @param {{ allowEmptyFleet?: boolean }} [o]
 * @returns {{ ok, from, to, decisions: { workflowId, decision: 'move'|'pin', revoked: string[] }[], freshRules: string[], counts, refused? }}
 */
export function vetPolicyChange(oldPolicy, newPolicy, fleet, { allowEmptyFleet = true } = {}) {
  const before = createGuard(oldPolicy);
  const after = createGuard(newPolicy);
  const activities = [...new Set([...Object.keys(oldPolicy.effects), ...Object.keys(newPolicy.effects)])].sort();
  const probe = [...activities, UNDECLARED];
  const allowed = (guard, policy, s, activity, at) => {
    const target = activity === UNDECLARED ? '(an activity neither policy declares)' : activity;
    const c = { ...classify(policy, target), target, argsDigest: 'ramp-probe', at };
    return guard.decide(s, c).outcome === 'allow';
  };
  let freshRules = [];
  const decisions = (fleet ?? []).map(({ workflowId, guard, at }) => {
    const carried = carryState(oldPolicy, newPolicy, guard);
    freshRules = carried.fresh;
    const revoked = probe.filter((a) => allowed(before, oldPolicy, guard, a, at) && !allowed(after, newPolicy, carried.state, a, at))
      .map((a) => (a === UNDECLARED ? '(undeclared activities)' : a));
    return { workflowId, decision: revoked.length ? 'pin' : 'move', revoked };
  });
  if (!(fleet ?? []).length) freshRules = carryState(oldPolicy, newPolicy, createGuard(oldPolicy).init()).fresh;
  const counts = decisions.reduce((a, d) => ({ ...a, [d.decision]: (a[d.decision] ?? 0) + 1 }), {});
  const empty = decisions.length === 0 && !allowEmptyFleet;
  return {
    ok: !empty && !decisions.some((d) => d.decision === 'pin'), from: oldPolicy.digest, to: newPolicy.digest, decisions, freshRules, counts,
    ...(empty ? { refused: 'no run under the old policy was vetted: pass allowEmptyFleet if there really are none' } : {}),
  };
}
