// Policy parsing and admission — FR-GRD.2, .5, .10; technical spec §3.4, §4.2.
//
// A policy maps the activities a workflow schedules to EFFECT KINDS with a
// consequence class and labels, and states rules over the sequence of those
// effects. Every rule names the kind it guards in `guards`; nothing is ever
// inferred from a rule's id (research/03 §5.4: a load-bearing name is how the
// old enforcement point decided what to guard, and it was fragile).
//
// Admission refuses rather than guesses: an unknown rule type, a rule guarding
// an undeclared kind, or a rule that makes its own guarded effect unreachable
// is a refused policy, with the reason.

import { digest } from './digest.mjs';

export const CLASSES = Object.freeze(['none', 'reversible', 'compensable', 'irreversible']);
export const LABELS = Object.freeze(['reads-private', 'reads-untrusted', 'egress']);
export const RULE_TYPES = Object.freeze(['requires-prior', 'implies-prior', 'at-most', 'never-after', 'trifecta', 'budget', 'rate']);
const UNLABELLED = new Set(['report', 'deny', 'escalate']);
const OUTCOMES = new Set(['deny', 'escalate']);

export class PolicyError extends Error {
  constructor(problems) {
    super(`policy refused:\n  - ${problems.join('\n  - ')}`);
    this.name = 'PolicyError';
    this.problems = problems;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate and normalise a policy. Returns a frozen, canonical-JSON-safe
 * object with `digest`. Throws PolicyError listing EVERY problem, not the first.
 */
export function parsePolicy(raw) {
  const problems = [];
  if (!isObj(raw)) throw new PolicyError(['a policy is a JSON object']);
  const name = typeof raw.policy === 'string' && raw.policy ? raw.policy : (problems.push('`policy` (the name) is required'), '?');
  const version = Number.isInteger(raw.version) && raw.version > 0 ? raw.version : (problems.push('`version` must be a positive integer'), 0);

  const effects = {};
  const kinds = new Set();
  for (const [activity, e] of Object.entries(raw.effects ?? {})) {
    if (!isObj(e) || typeof e.kind !== 'string' || !e.kind) { problems.push(`effects.${activity}: needs a string kind`); continue; }
    const cls = e.class ?? 'none';
    if (!CLASSES.includes(cls)) problems.push(`effects.${activity}: class '${cls}' is not one of ${CLASSES.join(', ')}`);
    const labels = [...new Set(e.labels ?? [])].sort();
    for (const l of labels) if (!LABELS.includes(l)) problems.push(`effects.${activity}: label '${l}' is not one of ${LABELS.join(', ')}`);
    effects[activity] = { kind: e.kind, class: cls, labels };
    kinds.add(e.kind);
  }
  if (Object.keys(effects).length === 0) problems.push('`effects` declares no activities: a policy with nothing to govern governs nothing');

  // Routes: an activity that carries MANY tools (the OpenAI Agents SDK runs
  // every MCP tool through one `<server>-call-tool-v2` activity, with the tool
  // name in its argument) is classified by a value inside its arguments:
  // routes: { "<activityType>": "<path into the argument list>" }, and the
  // effects are declared as "<activityType>:<value>" (plan P7.3a).
  const routes = {};
  for (const [activity, path] of Object.entries(raw.routes ?? {})) {
    if (typeof path !== 'string' || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(path)) problems.push(`routes.${activity}: a dotted path into the argument list, e.g. "0.tool_name"`);
    else routes[activity] = path;
  }

  const unlabelled = raw.unlabelled ?? 'report';
  if (!UNLABELLED.has(unlabelled)) problems.push(`unlabelled: '${unlabelled}' is not one of report, deny, escalate`);

  const known = (k, where) => { if (!kinds.has(k)) problems.push(`${where}: kind '${k}' is not declared by any effect`); };
  const ids = new Set();
  const rules = [];
  for (const [i, r] of (raw.rules ?? []).entries()) {
    const where = `rules[${i}]${r?.id ? ` (${r.id})` : ''}`;
    if (!isObj(r)) { problems.push(`${where}: not an object`); continue; }
    if (typeof r.id !== 'string' || !r.id) problems.push(`${where}: needs an id`);
    else if (ids.has(r.id)) problems.push(`${where}: duplicate id`);
    else ids.add(r.id);
    if (!RULE_TYPES.includes(r.type)) {
      problems.push(`${where}: unknown rule type '${r.type}' (known: ${RULE_TYPES.join(', ')})`);
      continue;
    }
    // An approval bound to one effect is asked for, not refused: its default outcome is escalate.
    const outcome = r.outcome ?? (r.bind === 'per-effect' ? 'escalate' : 'deny');
    if (!OUTCOMES.has(outcome)) problems.push(`${where}: outcome '${outcome}' is not deny or escalate`);
    const rule = { id: r.id, type: r.type, outcome };
    switch (r.type) {
      case 'requires-prior':
      case 'implies-prior':
        if (typeof r.guards !== 'string') problems.push(`${where}: \`guards\` (the kind this rule guards) is required`);
        else known(r.guards, where);
        if (typeof r.prior !== 'string') problems.push(`${where}: \`prior\` is required`);
        else known(r.prior, where);
        if (r.guards === r.prior) problems.push(`${where}: a kind cannot require itself as a prior — the first one could never happen`);
        rule.guards = r.guards;
        rule.prior = r.prior;
        rule.consume = r.consume ?? (r.type === 'requires-prior'); // one prior licenses one guarded effect
        rule.bind = r.bind ?? 'any';
        if (!['any', 'per-effect'].includes(rule.bind)) problems.push(`${where}: bind '${rule.bind}' is not any or per-effect`);
        break;
      case 'at-most':
        if (typeof r.guards !== 'string') problems.push(`${where}: \`guards\` is required`); else known(r.guards, where);
        if (!Number.isInteger(r.n) || r.n < 0) problems.push(`${where}: n must be a non-negative integer`);
        if (r.n === 0 && r.forbid !== true) problems.push(`${where}: n = 0 makes '${r.guards}' unreachable; say "forbid": true if that is the intent`);
        rule.guards = r.guards; rule.n = r.n;
        break;
      case 'never-after': {
        if (typeof r.guards !== 'string') problems.push(`${where}: \`guards\` is required`); else known(r.guards, where);
        const after = r.after ?? {};
        if (typeof after.kind === 'string') known(after.kind, where);
        else if (typeof after.signal !== 'string') problems.push(`${where}: after needs a kind or a signal`);
        rule.guards = r.guards;
        rule.after = typeof after.kind === 'string' ? { kind: after.kind } : { signal: after.signal };
        break;
      }
      case 'trifecta':
        rule.declassify = r.declassify ?? null;
        if (rule.declassify) known(rule.declassify, where);
        break;
      case 'budget':
        rule.metric = r.metric ?? 'effects';
        if (!Number.isFinite(r.max) || r.max < 0) problems.push(`${where}: max must be a non-negative number`);
        rule.max = r.max;
        rule.kinds = r.kinds ? [...r.kinds].sort() : null;
        for (const k of rule.kinds ?? []) known(k, where);
        if (rule.metric !== 'effects') {
          if (typeof r.from !== 'string' || !r.from) problems.push(`${where}: a '${rule.metric}' budget needs \`from\`, the result field to meter (e.g. "usage.total_tokens")`);
          rule.from = r.from;
        }
        break;
      case 'rate':
        if (typeof r.guards !== 'string') problems.push(`${where}: \`guards\` is required`); else known(r.guards, where);
        if (!Number.isInteger(r.n) || r.n < 1) problems.push(`${where}: n must be a positive integer`);
        if (!Number.isFinite(r.perMs) || r.perMs <= 0) problems.push(`${where}: perMs must be positive`);
        rule.guards = r.guards; rule.n = r.n; rule.perMs = r.perMs;
        break;
      default:
    }
    rules.push(rule);
  }

  const escalation = raw.escalation ?? null;
  if (escalation && (!Number.isFinite(escalation.timeoutMs ?? 0) || (escalation.timeoutMs ?? 0) < 0)) problems.push('escalation.timeoutMs must be a non-negative number');
  if ((unlabelled === 'escalate' || rules.some((r) => r.outcome === 'escalate' || r.bind === 'per-effect')) && !escalation) {
    problems.push('a rule escalates or binds approvals per effect, but no `escalation` { role, timeoutMs } is declared: nobody would be asked');
  }
  // Irreversible effects with no rule guarding them are the thing a policy exists to cover.
  const guarded = new Set(rules.map((r) => r.guards).filter(Boolean));
  const unguardedIrreversible = [...new Set(Object.values(effects).filter((e) => e.class === 'irreversible' && !guarded.has(e.kind)).map((e) => e.kind))];

  if (problems.length) throw new PolicyError(problems);
  const body = {
    policy: name, version, effects, ...(Object.keys(routes).length ? { routes } : {}), unlabelled, rules,
    escalation: escalation ? { role: escalation.role ?? 'approver', timeoutMs: escalation.timeoutMs ?? 24 * 3600_000 } : null,
  };
  return Object.freeze({ ...body, digest: digest(body), kinds: [...kinds].sort(), notes: unguardedIrreversible.map((k) => `irreversible kind '${k}' is guarded by no rule`) });
}

/**
 * The target an activity is classified as: its type, or, when the policy
 * routes that type, "<type>:<value at the route's path in the arguments>".
 * A missing or non-string value is "<type>:?", which no effect declares.
 */
export function routeTarget(policy, activityType, args) {
  const path = policy.routes?.[activityType];
  if (!path) return activityType;
  let v = args;
  for (const k of path.split('.')) {
    if (v == null || typeof v !== 'object') { v = undefined; break; }
    v = Array.isArray(v) ? (/^\d+$/.test(k) ? v[Number(k)] : undefined) : (Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined);
  }
  return typeof v === 'string' && v ? `${activityType}:${v}` : `${activityType}:?`;
}

/** How the guard sees an activity type: its declared kind, or 'unlabelled'. */
export function classify(policy, activityType) {
  const e = policy.effects[activityType];
  if (e) return { kind: e.kind, class: e.class, labels: e.labels, declared: true };
  // A routed call whose tool the policy does not name is DENIED whatever
  // `unlabelled` says: the agent chooses the route value, and a case variant or
  // a confusable of a denied tool must not pass as "unlabelled" (review SEC-UL1).
  const sep = activityType.indexOf(':');
  const routed = sep > 0 && Object.prototype.hasOwnProperty.call(policy.routes ?? {}, activityType.slice(0, sep));
  return { kind: `unlabelled:${activityType}`, class: 'unknown', labels: [], declared: false, ...(routed ? { routed: true } : {}) };
}
