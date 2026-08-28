// The decision journal (polyness spec §4.8).
//
// Once a rule is ENFORCED rather than merely proposed, the enforcement point
// produces the one kind of record no journal in this ecosystem holds. §6 of
// that spec measured the gap: today's transcript has no recoverable record of
// a refused tool call — and a refusal is the most informative event there is,
// because it sits exactly on the boundary the rule draws.
//
//   allow                the rule was satisfied
//   deny                 it fired
//   deny + overridden    it fired and was WRONG — a labelled false positive,
//                        with a timestamp and a command attached, produced as
//                        a byproduct of enforcement and obtainable no other way
//
// Every other harness records what the agent did. None record what it tried
// and was stopped from doing, because none make checkable denials in the first
// place. That stream is what `polyness replay` re-scores against, and what
// replaces its inferred cost proxy with an observed one.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const STORE = '.polyness';
export const FILE = 'decisions.jsonl';
export const journalPath = (root) => join(root, STORE, FILE);

/** Secret shapes, so a denied command's text cannot carry a key into the log. */
const SECRETS = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, /\bsk-[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
];
const ARG_MAX = 512;

/** §7 applies here in full: redact first, then truncate. */
export function redact(text) {
  let s = String(text ?? '');
  for (const re of SECRETS) s = s.replace(re, '[redacted]');
  return s.length > ARG_MAX ? `${s.slice(0, ARG_MAX)}…` : s;
}

/**
 * Append one decision. Best effort, deliberately.
 *
 * A gate that cannot write its journal still DECIDES. Enforcement never waits
 * on logging: a full disk must not become a way to get an unverified push
 * through, and it must not become a way to stop all work either.
 */
export function record(root, entry) {
  const line = {
    at: Date.now(),
    workflow: entry.workflow ?? null,
    instance: entry.instance ?? null,
    rules: entry.rules ?? [],
    kind: entry.kind ?? null,
    tool: entry.tool ?? null,
    arg: redact(entry.arg ?? ''),
    decision: entry.decision,
    reason: entry.reason ?? '',
    overridden: entry.overridden ?? false,
  };
  try {
    const p = journalPath(root);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify(line)}\n`, 'utf-8');
  } catch { /* the decision stands either way */ }
  return line;
}

/**
 * Mark the most recent denial of a kind as overridden — the user ran it
 * anyway.
 *
 * This is the labelled false positive, and it is the only observation in the
 * system that can tell a rule it is wrong. It is appended rather than edited:
 * a journal you can rewrite is not evidence.
 */
export function override(root, { kind, note = '' }) {
  return record(root, { kind, decision: 'deny', overridden: true, reason: note || 'ran anyway' });
}

/** Read the journal back, for `replay` and for anyone auditing the gate. */
export function read(root) {
  let text;
  try { text = readFileSync(journalPath(root), 'utf-8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn append is not fatal */ }
  }
  return out;
}

/**
 * What the journal says about one rule: how often it fired, and how often
 * firing was wrong.
 *
 * `replay`'s `blockedThenSucceeded` is a proxy inferred from history. This is
 * the observation that replaces it — and it only exists after somebody has
 * been denied something they wanted.
 */
export function costOf(entries, rule) {
  const mine = entries.filter((e) => (e.rules ?? []).includes(rule));
  const denials = mine.filter((e) => e.decision === 'deny');
  return {
    rule,
    allowed: mine.filter((e) => e.decision === 'allow').length,
    denied: denials.length,
    overridden: denials.filter((e) => e.overridden).length,
  };
}
