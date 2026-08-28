// The correspondence contract: does THIS tool call correspond to an open work
// order, or is it the guarded step happening outside the workflow?
//
// This is the whole of step 4b's difficulty, and it is not the plumbing. The
// gate sees `git push origin main`; the order book has an open `push` order.
// Deciding those are the same thing is where a naive version dies — a loose
// match is a hole (any command containing "push"), a strict one jams the first
// time an argument changes (`--force-with-lease` and nothing works).
//
// The descriptor's `tools` block already declares the tool per effect kind. A
// `match` beside it turns that declaration from documentation into a contract:
//
//   "push": { "tool": "Bash", "match": { "argv": ["git", "push"] }, "why": "…" }
//
// WHAT THIS BUYS. Without it the gate certifies that a workflow will never
// ORDER an unverified push — which is not the sentence a reader hears. With
// it, and with a hook that runs before the tool, "unreachable in the machine"
// and "cannot happen" become the same statement.

/** Tokens of a shell command, quotes stripped, `cd … &&` hops removed. */
export function argvOf(command) {
  let s = String(command ?? '').trim();
  for (let prev = null; prev !== s;) {
    prev = s;
    s = s.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;|\n)\s*/, '')
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, '')
      .trimStart();
  }
  // Only the first command of a chain is the one about to run. `npm test &&
  // git push` is a verification that may then push, and the gate sees it again
  // for the push if the shell gets that far.
  s = s.split(/\s*(?:&&|\|\||;|\|)\s*/)[0].trim();
  return s ? s.split(/\s+/).map((t) => t.replace(/^["'`]+|["'`]+$/g, '')).filter(Boolean) : [];
}

/**
 * Can this effect's `match` be evaluated at all?
 *
 * The gate uses this at ADMISSION time: a workflow that asserts an invariant
 * over an effect the enforcement point cannot recognise is refused, rather
 * than admitted with a guarantee nothing can keep. The two halves police each
 * other, which is the only reason either is worth trusting.
 */
export function matchable(spec) {
  if (!spec || typeof spec !== 'object') return false;
  const m = spec.match;
  if (!m || typeof m !== 'object') return false;
  if (Array.isArray(m.argv)) return m.argv.length > 0 && m.argv.every((t) => typeof t === 'string' && t);
  if (typeof m.tool === 'string' && m.tool) return true;
  return false;
}

/** Does a tool call look like this effect? */
export function looksLike(spec, { tool, input }) {
  if (!matchable(spec)) return false;
  if (spec.tool && spec.tool !== tool) return false;
  const m = spec.match;
  if (Array.isArray(m.argv)) {
    if (tool !== 'Bash') return false;
    const argv = argvOf(input?.command);
    // A PREFIX match: `["git","push"]` matches `git push origin main
    // --force-with-lease` and does not match `git status`. Prefix rather than
    // equality is what keeps the contract from jamming on an added flag.
    return m.argv.every((t, i) => argv[i] === t);
  }
  return m.tool === tool;
}

export const ALLOW = 'allow';
export const DENY = 'deny';

/**
 * Decide one tool call.
 *
 * DEFAULT IS ALLOW. The gate must never interfere with work unrelated to a
 * running workflow — a user whose shell stops working because polyflow is
 * running is a user who turns polyflow off, and then it guards nothing at all.
 *
 * Denial happens only where all three are true:
 *   the call looks like a GUARDED effect (one an admitted invariant mentions),
 *   of a workflow that is RUNNING right now,
 *   and that instance has no open order for it.
 *
 * FAIL-CLOSED, NARROWLY. When the order book cannot be read, a guarded effect
 * is denied and everything else is allowed. Globally fail-closed bricks the
 * shell; globally fail-open evaporates the guarantee exactly when things are
 * broken. Scoping it this way makes the blast radius equal to the promise —
 * an unreachable order book must deny a guarded push and still allow `ls`.
 */
export function decide({ tool, input }, book) {
  const { guarded = new Map(), openKinds = null, unreachable = false } = book ?? {};

  for (const [kind, { spec, workflow, rules }] of guarded) {
    if (!looksLike(spec, { tool, input })) continue;

    if (unreachable) {
      return {
        decision: DENY, kind, workflow, rules,
        reason: `polyflow's order book is unreachable and '${kind}' is guarded by `
          + `${rules.join(', ')}. Start the workflow, or stop polyflow to run this by hand.`,
      };
    }
    if (openKinds?.has(kind)) return { decision: ALLOW, kind, workflow, reason: 'an open order awaits this' };
    return {
      decision: DENY, kind, workflow, rules,
      reason: `'${kind}' is guarded by ${rules.join(', ')} in workflow '${workflow}', `
        + 'and no run of it is waiting for this step. Start the workflow with '
        + `workflow_start ${workflow}.`,
    };
  }
  return { decision: ALLOW, reason: 'not a guarded effect of any running workflow' };
}
