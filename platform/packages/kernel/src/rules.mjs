// The G1 rule kernel — FR-GRD.1–.8; technical spec §4.1, §6.3.
//
// A deterministic reducer over a run's effects. It holds no clock, no
// randomness and no environment: time arrives as `at` (workflow time), and
// every function returns a NEW state rather than mutating, so the workflow can
// recompute it on replay and get the same bytes.
//
//   guard  = createGuard(policy)
//   s0     = guard.init()
//   d      = guard.decide(s, candidate)          what would happen to this effect now?
//   s1     = guard.commit(s, candidate, d)       it was allowed and scheduled
//   s2     = guard.observe(s1, observation)      its result came back
//   s3     = guard.signal(s2, name, at)          an out-of-band event
//   s4     = guard.grant(s3, approval)           a principal approved ONE effect
//
// A candidate is { kind, class, labels, argsDigest, target, at, declared }.
// A decision is { outcome: allow|deny|escalate, rules: [ids that fired],
// witness, message, approval? } — every firing rule is reported, not only the
// first, so a witness is complete.

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Read a dotted path out of an activity result, for metered budgets. */
const pick = (obj, path) => {
  let v = obj;
  for (const k of String(path).split('.')) { if (v == null) return undefined; v = v[k]; }
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

const TRACE_MAX = 32;

export function createGuard(policy) {
  const rules = policy.rules;
  const kindsOf = policy.kinds;
  const labelsOfKind = {};
  for (const e of Object.values(policy.effects)) {
    labelsOfKind[e.kind] = [...new Set([...(labelsOfKind[e.kind] ?? []), ...e.labels])].sort();
  }

  function init() {
    const credits = {};
    for (const r of rules) if ((r.type === 'requires-prior' || r.type === 'implies-prior') && r.consume) credits[r.id] = 0;
    return {
      seq: 0,                 // effects committed so far
      n: {},                  // kind -> effects scheduled
      ok: {},                 // kind -> effects that succeeded
      credits,                // consuming prior rules: priors not yet used up
      approvals: [],          // { id, kind, argsDigest, principal, at, consumed }
      taint: { untrusted: false, private: false, declassified: false, lastSeq: 0 },
      meters: {},             // budget rule id -> amount used
      rate: {},               // rate rule id -> [at, ...] inside the window
      signals: {},            // signal name -> at
      trace: [],              // the last TRACE_MAX { seq, kind, ok } — witness material
    };
  }

  // An approval licenses ONE effect: this kind, these canonical arguments, and
  // the proposal it was asked for (FR-HUM.3). The interceptor always grants
  // with the proposal id, so a later proposal with the same arguments cannot
  // inherit an approval whose own effect was denied (P2/P3 review G3); an
  // approval voided after such a denial is dead either way.
  const approvalFor = (s, c) => s.approvals.find((a) => !a.consumed && !a.void && a.kind === c.kind && a.argsDigest === c.argsDigest
    && (a.proposal == null || a.proposal === c.proposal));

  /** Every rule that bears on this candidate, with whether it holds. */
  function evaluate(s, c) {
    const out = [];
    for (const r of rules) {
      switch (r.type) {
        case 'requires-prior':
        case 'implies-prior': {
          if (c.kind !== r.guards) break;
          let holds;
          if (r.bind === 'per-effect') holds = false; // only a matching approval satisfies it (below)
          else if (r.consume) holds = (s.credits[r.id] ?? 0) > 0;
          else holds = ((r.type === 'requires-prior' ? s.ok : s.n)[r.prior] ?? 0) > 0;
          out.push({ r, holds, fix: r.bind === 'per-effect'
            ? `'${r.guards}' needs an approval for this exact effect; it has been requested`
            : r.type === 'requires-prior'
              ? `run '${r.prior}' and wait for it to succeed before '${r.guards}'${r.consume ? ` (each '${r.prior}' licenses one '${r.guards}')` : ''}`
              : `order '${r.prior}' before '${r.guards}'` });
          break;
        }
        case 'at-most': {
          if (c.kind !== r.guards) break;
          const used = s.n[r.guards] ?? 0;
          out.push({ r, holds: used < r.n, fix: `'${r.guards}' may happen at most ${r.n} time(s) in this run; it has happened ${used}` });
          break;
        }
        case 'never-after': {
          if (c.kind !== r.guards) break;
          const after = r.after.kind ? (s.n[r.after.kind] ?? 0) > 0 : s.signals[r.after.signal] !== undefined;
          out.push({ r, holds: !after, fix: `'${r.guards}' is not allowed after ${r.after.kind ? `'${r.after.kind}'` : `the ${r.after.signal} signal`}` });
          break;
        }
        case 'trifecta': {
          if (!(c.labels ?? []).includes('egress')) break;
          const exposed = s.taint.untrusted && s.taint.private && !s.taint.declassified;
          out.push({ r, holds: !exposed, fix: `this run has read untrusted content and private data; an egress effect needs ${r.declassify ? `'${r.declassify}' first, or ` : ''}an approval for this exact effect` });
          break;
        }
        case 'budget': {
          if (r.kinds && !r.kinds.includes(c.kind)) break;
          const used = r.metric === 'effects' ? (s.meters[r.id] ?? 0) : (s.meters[r.id] ?? 0);
          const holds = r.metric === 'effects' ? used + 1 <= r.max : used < r.max;
          out.push({ r, holds, fix: `budget '${r.id}' is exhausted (${used} of ${r.max} ${r.metric})` });
          break;
        }
        case 'rate': {
          if (c.kind !== r.guards) break;
          const window = (s.rate[r.id] ?? []).filter((t) => t > c.at - r.perMs);
          const holds = window.length < r.n;
          out.push({ r, holds, fix: holds ? '' : `at most ${r.n} '${r.guards}' per ${r.perMs} ms; the next is allowed at ${window[0] + r.perMs}` });
          break;
        }
        default:
      }
    }
    return out;
  }

  function witness(s, c, failed) {
    const involved = new Set([c.kind, ...failed.flatMap(({ r }) => [r.prior, r.after?.kind].filter(Boolean))]);
    return {
      rules: failed.map(({ r }) => ({ id: r.id, type: r.type, fix: failed.find((f) => f.r === r).fix })),
      candidate: { kind: c.kind, target: c.target, argsDigest: c.argsDigest },
      counters: { scheduled: s.n[c.kind] ?? 0, succeeded: s.ok[c.kind] ?? 0 },
      sequence: s.trace.filter((t) => involved.has(t.kind)),
      allowedNow: allowedNow(s, c.at),
    };
  }

  function decideInner(s, c, withWitness) {
    if (!c.declared) {
      // An undeclared effect is still an effect: a budget with no kinds caps it
      // too (P2/P3 review G5), and an escalation of it can be approved (G2).
      const budgets = evaluate(s, c).filter((e) => e.r.type === 'budget' && !e.r.kinds);
      const over = budgets.filter((e) => !e.holds);
      if (over.length) {
        const denies = over.filter((f) => f.r.outcome === 'deny');
        const shown = denies.length ? denies : over;
        if (!denies.length) { const a = approvalFor(s, c); if (a) return { outcome: 'allow', rules: shown.map((f) => f.r.id), approval: a.id }; }
        return { outcome: denies.length ? 'deny' : 'escalate', rules: shown.map((f) => f.r.id), message: shown.map((f) => `${f.r.id}: ${f.fix}`).join('; '), witness: withWitness ? witness(s, c, shown) : undefined };
      }
      if (policy.unlabelled === 'report' && !c.routed) return { outcome: 'allow', rules: ['unlabelled', ...budgets.map((e) => e.r.id)], note: `'${c.target}' is not declared in policy '${policy.policy}'` };
      if (policy.unlabelled === 'escalate' && !c.routed) {
        const a = approvalFor(s, c);
        if (a) return { outcome: 'allow', rules: ['unlabelled'], approval: a.id };
      }
      const fix = `activity '${c.target}' is not declared in policy '${policy.policy}'`;
      return {
        outcome: c.routed ? 'deny' : policy.unlabelled, rules: ['unlabelled'], message: fix,
        witness: withWitness ? { rules: [{ id: 'unlabelled', type: 'unlabelled', fix }], candidate: { kind: c.kind, target: c.target, argsDigest: c.argsDigest }, counters: {}, sequence: [], allowedNow: allowedNow(s, c.at) } : undefined,
      };
    }
    const evals = evaluate(s, c);
    const failed = evals.filter((e) => !e.holds);
    const fired = evals.map((e) => e.r.id);
    if (failed.length === 0) return { outcome: 'allow', rules: fired };
    // An approval granted for THIS effect (kind + canonical arguments) satisfies
    // every failing rule whose outcome is escalate — that is what the human was
    // asked. It never overrides a deny.
    const denies = failed.filter((f) => f.r.outcome === 'deny');
    const escalations = failed.filter((f) => f.r.outcome === 'escalate');
    if (denies.length === 0) {
      const a = approvalFor(s, c);
      if (a) return { outcome: 'allow', rules: fired, approval: a.id };
    }
    const outcome = denies.length ? 'deny' : 'escalate';
    const shown = denies.length ? denies : escalations;
    return {
      outcome,
      rules: shown.map((f) => f.r.id),
      message: shown.map((f) => `${f.r.id}: ${f.fix}`).join('; '),
      witness: withWitness ? witness(s, c, shown) : undefined,
    };
  }

  const decide = (s, c) => decideInner(s, c, true);

  /** The declared effect kinds that would be allowed right now (no approvals assumed). */
  function allowedNow(s, at) {
    return kindsOf.filter((k) => decideInner(s, { kind: k, labels: labelsOfKind[k], declared: true, argsDigest: null, target: k, at }, false).outcome === 'allow');
  }

  /** The effect was allowed and scheduled. */
  function commit(s0, c, d) {
    const s = clone(s0);
    s.seq += 1;
    s.n[c.kind] = (s.n[c.kind] ?? 0) + 1;
    if (d?.approval) for (const a of s.approvals) if (a.id === d.approval) a.consumed = true;
    for (const r of rules) {
      if ((r.type === 'requires-prior' || r.type === 'implies-prior') && r.consume && r.guards === c.kind && r.bind !== 'per-effect') {
        s.credits[r.id] = Math.max(0, (s.credits[r.id] ?? 0) - 1);
      }
      if (r.type === 'budget' && r.metric === 'effects' && (!r.kinds || r.kinds.includes(c.kind))) s.meters[r.id] = (s.meters[r.id] ?? 0) + 1;
      if (r.type === 'rate' && r.guards === c.kind) s.rate[r.id] = [...(s.rate[r.id] ?? []).filter((t) => t > c.at - r.perMs), c.at];
      if (r.type === 'implies-prior' && r.consume && r.prior === c.kind) s.credits[r.id] = (s.credits[r.id] ?? 0) + 1;
    }
    s.trace = [...s.trace, { seq: s.seq, kind: c.kind, ok: null }].slice(-TRACE_MAX);
    return s;
  }

  /** An effect's result came back. `result` is read only for metered budgets and is never stored. */
  function observe(s0, { kind, ok, labels = labelsOfKind[kind] ?? [], result, seq }) {
    const s = clone(s0);
    // Which effect this is: its commit seq when given, else the oldest open one of the kind.
    let effectSeq = seq;
    for (const t of s.trace) {
      if (t.kind === kind && t.ok === null && (seq === undefined || t.seq === seq)) { t.ok = Boolean(ok); effectSeq = t.seq; break; }
    }
    effectSeq = effectSeq ?? s.seq;
    s.taint.lastSeq = s.taint.lastSeq ?? 0;
    // An untrusted read taints even when it fails: its error text reaches the
    // agent all the same (P2/P3 review G9).
    if (labels.includes('reads-untrusted')) { s.taint.untrusted = true; s.taint.declassified = false; s.taint.lastSeq = Math.max(s.taint.lastSeq, effectSeq); }
    if (!ok) return s;
    s.ok[kind] = (s.ok[kind] ?? 0) + 1;
    for (const r of rules) {
      if (r.type === 'requires-prior' && r.consume && r.prior === kind && r.bind !== 'per-effect') s.credits[r.id] = (s.credits[r.id] ?? 0) + 1;
      if (r.type === 'budget' && r.metric !== 'effects' && (!r.kinds || r.kinds.includes(kind))) {
        const v = pick(result, r.from);
        // A reading can only spend budget. A negative one is not a refund, it is
        // a reading nobody can trust: the budget closes (fail closed, review G4).
        if (v !== undefined && v < 0) s.meters[r.id] = Math.max(s.meters[r.id] ?? 0, r.max);
        else if (v !== undefined) s.meters[r.id] = (s.meters[r.id] ?? 0) + v;
      }
    }
    if (labels.includes('reads-private')) { s.taint.private = true; s.taint.declassified = false; s.taint.lastSeq = Math.max(s.taint.lastSeq, effectSeq); }
    // A declassification cleans only what was read BEFORE it was ordered (review G6).
    for (const r of rules) if (r.type === 'trifecta' && r.declassify === kind && effectSeq > s.taint.lastSeq) s.taint.declassified = true;
    return s;
  }

  function signal(s0, name, at) {
    const s = clone(s0);
    s.signals[name] = at;
    return s;
  }

  /** A principal approved ONE effect: this kind, with exactly these canonical arguments. */
  function grant(s0, { id, kind, argsDigest, proposal = null, principal = null, at }) {
    const s = clone(s0);
    if (s.approvals.some((a) => a.id === id)) return s; // idempotent
    s.approvals.push({ id, kind, argsDigest, proposal, principal, at, consumed: false });
    return s;
  }

  /** The effect an approval was granted for did not happen: the approval dies with it. */
  function voidApproval(s0, id) {
    const s = clone(s0);
    for (const a of s.approvals) if (a.id === id) a.void = true;
    return s;
  }

  return { init, decide, commit, observe, signal, grant, voidApproval, allowedNow, policy };
}
