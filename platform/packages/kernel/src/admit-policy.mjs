// Policy admission — FR-GRD.10; technical spec §4.2.
//
// Parsing proves the policy is well-formed. Admission proves one more thing:
// every kind a rule guards can still HAPPEN on some sequence of declared
// effects. A rule set that makes its guarded effect unreachable is almost
// always a mistake (a prior that is itself guarded by the effect it licenses,
// a budget of zero), and a gate that denies everything is not a policy, it is
// an outage. Unless the policy says `forbid: true`, it is refused.
//
// The search runs once per kind, over only the kinds that can help it happen:
// its priors, their priors, and so on. Every other rule type can only ever
// BLOCK a kind once something else has happened (never-after, at-most, rate,
// budgets, the trifecta), so scheduling fewer effects never hurts
// reachability, and those kinds are left out of the walk. That keeps the walk
// small however many tools a policy declares (P2/P3 review A1: the single
// global walk was exponential in the number of kinds). Each walk is a
// breadth-first search over guard states, every effect succeeding, an
// escalation counted as reachable (a human can approve it), bounded by depth
// = the number of relevant kinds + 2, and a kind not reached within its bound
// is reported unreachable: bounded is not a pass.

import { parsePolicy, PolicyError } from './policy.mjs';
import { createGuard } from './rules.mjs';
import { canonical } from './canonical.mjs';

/** The kinds that can help `target` happen: the closure of its prior kinds. */
function relevantKinds(policy, target) {
  const out = new Set([target]);
  const queue = [target];
  while (queue.length) {
    const k = queue.pop();
    for (const r of policy.rules) {
      if ((r.type === 'requires-prior' || r.type === 'implies-prior') && r.guards === k && r.bind !== 'per-effect' && !out.has(r.prior)) {
        out.add(r.prior);
        queue.push(r.prior);
      }
    }
  }
  return [...out].sort();
}

function reach(policy, guard, target, labelsOf) {
  const kinds = relevantKinds(policy, target);
  const depth = kinds.length + 2;
  const cap = 1 + Math.max(1, ...policy.rules.map((r) => (Number.isFinite(r.n) ? r.n : Number.isFinite(r.max) ? r.max : 1)));
  const capAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.min(v, cap)]));
  const key = (s) => canonical({ ...s, seq: 0, n: capAll(s.n), ok: capAll(s.ok), credits: capAll(s.credits), meters: capAll(s.meters), approvals: [], trace: [], rate: {} });
  const seen = new Set();
  let frontier = [guard.init()];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const s of frontier) {
      for (const kind of kinds) {
        const at = (d + 1) * 1e12; // far apart: rate windows never bind in this search
        const c = { kind, labels: labelsOf[kind], declared: true, argsDigest: `reach:${kind}`, target: kind, at, proposal: `reach-${d}-${kind}` };
        let st = s;
        let dec = guard.decide(st, c);
        if (dec.outcome === 'escalate') {
          st = guard.grant(st, { id: `reach-${d}-${kind}`, kind, argsDigest: c.argsDigest, proposal: c.proposal, at });
          dec = guard.decide(st, c);
        }
        if (dec.outcome !== 'allow') continue;
        if (kind === target) return { reached: true, depth };
        const after = guard.observe(guard.commit(st, c, dec), { kind, ok: true });
        const k = key(after);
        if (!seen.has(k)) { seen.add(k); next.push(after); }
      }
    }
    frontier = next;
  }
  return { reached: false, depth };
}

export function reachability(policy, { skip = new Set() } = {}) {
  const guard = createGuard(policy);
  const labelsOf = {};
  for (const e of Object.values(policy.effects)) labelsOf[e.kind] = e.labels;
  const reached = [];
  const unreachable = [];
  let depth = 0;
  for (const kind of policy.kinds) {
    if (skip.has(kind)) continue;
    const r = reach(policy, guard, kind, labelsOf);
    depth = Math.max(depth, r.depth);
    (r.reached ? reached : unreachable).push(kind);
  }
  return { reached, unreachable, depth };
}

/** Parse, then refuse any guarded kind that can never happen (unless forbidden on purpose). */
export function admitPolicy(raw) {
  const policy = parsePolicy(raw);
  const forbidden = new Set((raw.rules ?? []).filter((r) => r.forbid === true).map((r) => r.guards));
  const { unreachable, depth } = reachability(policy, { skip: forbidden });
  const problems = unreachable.map((k) => `kind '${k}' can never be allowed under these rules (searched every sequence of the effects that could license it, to depth ${depth})`);
  if (problems.length) throw new PolicyError(problems);
  return policy;
}
