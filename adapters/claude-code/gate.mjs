// The enforcement point: a `PreToolUse` gate that denies a guarded step when
// no run of its workflow is waiting for it.
//
// WHY THIS EXISTS. Without it polyflow's certificate says a workflow will never
// ORDER an unverified push — true, and not the sentence anyone reads it as. A
// confused or injected agent can still call `Bash: git push` outside the
// workflow entirely, because the machine is a checked ADVISOR to an unchecked
// EXECUTOR. This closes that: with the gate in front of the tool,
// "unreachable in the machine" and "cannot happen" become one statement.
//
// SHAPE. In-process, taking the agent's own hook callback. Measured in
// polysec's `examples/polysec-agent-gate`: the command-hook transport costs
// ~940ms per tool call, of which ~830ms is a bare node startup, while the
// in-process decision is 17.7µs. That difference is the whole question of
// whether a user leaves it switched on.
//
// The fact the guarantee rests on: hooks run FIRST in the six-step permission
// pipeline, and a hook deny holds even under `bypassPermissions`.
//
//   import { Polyflow } from 'polyflow';
//   import { polyflowGate } from 'polyflow/adapters/claude-code/gate.mjs';
//
//   const pf = new Polyflow({ … }); await pf.start();
//   const gate = polyflowGate(pf, { root: process.cwd() });
//   for await (const m of query({ prompt, options: { hooks: gate.hooks } })) { … }
//
// $0 on the decision path: no model call, no network, no clock.
import { decide, matchable, ALLOW } from '../../src/match.mjs';
import { record } from '../../src/decisions.mjs';

/**
 * Which effect a rule constrains, from its name.
 *
 * ANCHORED, not a substring test. `no-push-without-a-passing-verify` contains
 * the word "verify", and reading it as a rule about the `verify` effect made
 * the gate offer to block a user running their tests by hand — which is how a
 * gate gets switched off, and then it guards nothing at all.
 *
 * The four shapes are polyness §4.4's vocabulary, which is also the one the
 * hand-written workflows are named in.
 */
export function guardsOf(rule) {
  let m = /^no-(.+)-without-a-/.exec(rule);
  if (m) return m[1];
  m = /^at-most-one-(.+)-per-run$/.exec(rule);
  if (m) return m[1];
  m = /^exactly-one-(.+)-per-(.+)-run$/.exec(rule);
  if (m) return m[2];
  m = /^(.+)-implies-a-prior-(.+)$/.exec(rule);
  if (m) return m[1];
  return null;
}

/**
 * Which effects are GUARDED, and by which rules.
 *
 * TWO conditions, and the first is the author's. An effect is gated only if
 * its descriptor gives it a `match`, and only if an admitted invariant
 * constrains it. Requiring the `match` makes gating opt-in per effect, which
 * matters because a workflow's invariants also cover steps that are perfectly
 * safe to repeat — `at-most-one-verify-per-run` is a rule about the workflow's
 * own emissions, not a reason to stop somebody running their tests.
 *
 * The point is to police the promises that concern steps you cannot take back.
 */
export function guardedEffects(pf) {
  const guarded = new Map();
  for (const wf of pf.library.workflows.values()) {
    if (!pf.admitted(wf.name)) continue;
    const rules = pf._guarantees(wf.name);
    if (!rules.length) continue;
    for (const [kind, spec] of Object.entries(wf.tools ?? {})) {
      if (!matchable(spec)) continue;
      const mine = rules.filter((r) => guardsOf(r) === kind);
      if (mine.length) guarded.set(kind, { spec, workflow: wf.name, rules: mine });
    }
  }
  return guarded;
}

/**
 * Every effect kind some LIVE run currently has an open order for.
 *
 * Filtered on `done` rather than on a status string: a run can be `active` in
 * the store and still be finished, and a finished run's orders are not an
 * invitation to do anything.
 */
export async function openKinds(pf) {
  const kinds = new Set();
  for (const r of await pf.runs()) {
    if (r.done) continue;
    for (const o of pf.broker.open(r.instanceId)) kinds.add(o.kind);
  }
  return kinds;
}

/**
 * Admission-time companion: a workflow whose invariants name an effect the
 * gate cannot recognise is refused.
 *
 * The gate and the certificate police each other. Without this a workflow
 * could be admitted carrying a promise nothing is able to keep, which is worse
 * than no promise at all — it reads exactly like one that is kept.
 */
export function unenforceable(wf, rules) {
  const bad = [];
  for (const [kind, spec] of Object.entries(wf.tools ?? {})) {
    if (!rules.some((r) => guardsOf(r) === kind)) continue;
    if (!matchable(spec)) bad.push(kind);
  }
  return bad;
}

/**
 * Build the gate. Once per agent process: the workflow library and the guarded
 * set are read here, not per tool call, which is the point of the in-process
 * shape.
 */
export function polyflowGate(pf, { root = process.cwd(), onDecision = null } = {}) {
  const guarded = guardedEffects(pf);

  const evaluate = async ({ tool_name: tool, tool_input: input }) => {
    let book;
    try {
      book = { guarded, openKinds: await openKinds(pf) };
    } catch {
      // Fail CLOSED for guarded effects and OPEN for everything else. A
      // polyflow outage may not stop a user running `ls`, and may not become a
      // way to push unverified either.
      book = { guarded, unreachable: true };
    }
    const verdict = decide({ tool, input }, book);
    const entry = record(root, {
      workflow: verdict.workflow, kind: verdict.kind, rules: verdict.rules,
      tool, arg: tool === 'Bash' ? input?.command : JSON.stringify(input ?? {}),
      decision: verdict.decision, reason: verdict.reason,
    });
    onDecision?.(entry);
    return verdict;
  };

  return {
    evaluate,
    guarded,
    /** The shape Claude Code's SDK expects for a `PreToolUse` hook. */
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [async (payload) => {
          const verdict = await evaluate(payload);
          if (verdict.decision === ALLOW) return {};
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: verdict.reason,
            },
          };
        }],
      }],
    },
  };
}
