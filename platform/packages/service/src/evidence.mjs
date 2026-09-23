// The run report and the evidence pack — FR-OBS.4, FR-OBS.5. Pure functions
// of what the store holds: the same inputs give the same bytes.
//
// The evidence pack answers the question a risk officer or an auditor asks
// about a namespace and a period: which rules were in force, did they hold,
// who was asked to decide what, and can the record be trusted — mapped onto
// the headings of the frameworks they report against. It states what it does
// NOT show as plainly as what it does. Empty is never green (doctrine 2): a
// control over nothing is `holds: null`, with the reason, never `true`.

import { verifyBundle } from '@cognitive-fab/polyflow-temporal';

const DISCLOSURE = 'Consistency checks, not proofs. A verified ledger shows the record was not altered after it was signed and is consistent with itself; it does not show the world matched the record. Approvals marked unverified name a principal the caller asserted.';

/** Markdown inline text: no table breaks, no markup from a workflow id. */
const md = (s) => String(s ?? '').replace(/[\\`*_[\]<>|#]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, ' ');
/** Inside a code span nothing is markup: only a backtick or a line break can end it early. */
const code = (s) => String(s ?? '').replace(/`/g, "'").replace(/[\r\n|]+/g, ' ');

/** Verify one run and summarise it. `verified` means closed and signed through its last event. */
export function runSummary(events, heads, trust) {
  const v = verifyBundle({ events, heads, trust, allowOpen: true });
  const admission = events.find((e) => e.kind === 'admission')?.body ?? {};
  const closure = [...events].reverse().find((e) => e.kind === 'closure')?.body?.outcome ?? null;
  const verdicts = events.filter((e) => e.kind === 'verdict');
  return {
    run: events[0]?.run,
    level: admission.level ?? null,
    policy: admission.policy ?? null,
    outcome: closure,
    // An open run whose events are all signed is consistent so far, not verified (review EV).
    verified: v.ok && v.closed,
    consistent: v.ok,
    open: !v.closed,
    verdict: v.verdict,
    problems: v.problems,
    effects: events.filter((e) => e.kind === 'effect').length,
    denied: verdicts.filter((e) => e.body.outcome === 'denied').length,
    escalated: verdicts.filter((e) => e.body.outcome === 'escalated').length,
  };
}

/** A deterministic one-page Markdown report for one run (FR-OBS.5). */
export function runReport(events, heads, trust) {
  const s = runSummary(events, heads, trust);
  const record = s.verified ? 'verified' : s.consistent ? 'signed so far, still open' : 'NOT verified';
  const lines = [
    `# Run ${md(s.run.wf)}`,
    '',
    `- namespace \`${code(s.run.ns)}\`, chain started by run \`${code(s.run.run)}\``,
    `- level **${md(s.level ?? 'unknown')}**${s.policy ? `, policy **${md(s.policy.name)} v${md(s.policy.version)}** (\`${code(s.policy.digest)}\`)` : ''}`,
    `- outcome **${md(s.outcome ?? 'still open')}**`,
    `- record: **${record}** (${s.verdict})${s.problems.length ? ` — ${md(s.problems.join('; '))}` : ''}`,
    '',
    '## What happened',
    '',
    '| seq | event | detail |',
    '|---|---|---|',
  ];
  for (const e of events) {
    const b = e.body ?? {};
    let detail = '';
    if (e.kind === 'proposal') detail = `${b.source} proposed \`${b.action}\`${b.principal ? ` (principal ${b.principal.id}${b.principal.verified ? '' : ', unverified'})` : ''}`;
    else if (e.kind === 'verdict') detail = `${b.outcome}${b.rules?.length ? ` by ${b.rules.join(', ')}` : ''}${b.reason && b.outcome !== 'allowed' ? ` — ${b.reason}` : ''}`;
    else if (e.kind === 'effect') detail = `${b.activityType ?? b.kind} (${b.class})${b.approval ? `, approval ${b.approval}` : ''}`;
    else if (e.kind === 'observation') detail = b.ok ? 'succeeded' : `failed: ${b.error ?? ''}`;
    else if (e.kind === 'admission') detail = `admitted at level ${b.level}`;
    else if (e.kind === 'closure') detail = b.outcome;
    lines.push(`| ${e.seq} | ${e.kind} | ${detail.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')} |`);
  }
  const head = events.at(-1);
  lines.push('', `Chain head: seq ${head?.seq}, \`${head?.hash}\`.`, '', `> ${DISCLOSURE}`, '');
  return lines.join('\n');
}

/**
 * Parse an evidence period from query strings: epoch ms, or an ISO date.
 * Returns { from, to } or { error }. Absent bounds are open.
 */
export function parsePeriod(fromText, toText) {
  const parse = (t, name, dflt) => {
    if (t === null || t === undefined || t === '') return dflt;
    const n = /^\d+$/.test(t) ? Number(t) : Date.parse(t);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`'${name}' is neither epoch milliseconds nor an ISO date: '${t}'`);
    return n;
  };
  try {
    const from = parse(fromText, 'from', 0);
    const to = parse(toText, 'to', Number.MAX_SAFE_INTEGER);
    if (from >= to) return { error: `the period is empty: from ${from} is not before to ${to}` };
    return { from, to };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * The evidence pack for a namespace and period (FR-OBS.4).
 * @param {object} o
 * @param {import('./store.mjs').Store} o.store
 * @param {string} o.ns
 * @param {number} o.from   epoch ms, inclusive
 * @param {number} o.to     epoch ms, exclusive
 * @param {object} o.trust  keyId -> public key PEM
 */
export function evidencePack({ store, ns, from, to, trust }) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error(`not a period: from ${from}, to ${to}`);
  const runs = store.runs({ ns }).filter((r) => r.last >= from);
  const summaries = [];
  // Statistics come from runs whose record is consistent (closed and
  // verified, or open and signed so far); the others are counted apart.
  const trusted = [];
  const excluded = { runs: 0, events: 0 };
  for (const r of runs) {
    const { events, heads } = store.read(r);
    const inPeriod = events.filter((e) => e.at >= from && e.at < to);
    if (!inPeriod.length) continue;
    const s = runSummary(events, heads, trust);
    summaries.push(s);
    if (s.consistent) trusted.push(inPeriod);
    else { excluded.runs += 1; excluded.events += inPeriod.length; }
  }
  const of = (kind) => trusted.flatMap((evs) => evs.filter((e) => e.kind === kind));
  const verdicts = of('verdict');
  const admissions = of('admission');
  const byRule = {};
  for (const v of verdicts) {
    for (const rule of v.body.rules ?? []) {
      byRule[rule] ??= { allowed: 0, denied: 0, escalated: 0 };
      // Every outcome is counted, plan verdicts (accepted / rejected) included.
      byRule[rule][v.body.outcome] = (byRule[rule][v.body.outcome] ?? 0) + 1;
    }
  }
  // An escalation is answered when a person decided it: a human proposal
  // naming its approval id (or, for records without ids, one in the same run).
  let escalations = 0;
  let answered = 0;
  const human = [];
  for (const evs of trusted) {
    const decisions = evs.filter((e) => e.kind === 'proposal' && e.body.source === 'human');
    human.push(...decisions);
    const byId = new Set(decisions.map((d) => d.body.approvalId).filter(Boolean));
    let loose = decisions.filter((d) => !d.body.approvalId).length;
    for (const v of evs.filter((e) => e.kind === 'verdict' && e.body.outcome === 'escalated')) {
      escalations += 1;
      if (v.body.approvalId && byId.has(v.body.approvalId)) answered += 1;
      else if (!v.body.approvalId && loose > 0) { loose -= 1; answered += 1; }
    }
  }
  const policies = {};
  for (const a of admissions) {
    const p = a.body.policy;
    if (!p) continue;
    const k = `${p.name}@${p.version}`;
    policies[k] ??= { name: p.name, version: p.version, digest: p.digest, runs: 0 };
    policies[k].runs += 1;
  }
  // In force in this namespace during the period: registered for it before
  // the period ended, or named by an admission in it.
  const buildIds = [...new Set(admissions.map((a) => a.body.certificate?.buildId ?? a.body.buildId).filter((b) => typeof b === 'string'))];
  const certificates = store.certificates({ ns, to, buildIds });
  const alerts = store.alerts().filter((a) => a.ns === ns && a.at >= from && a.at < to);
  const verified = summaries.filter((s) => s.verified).length;
  const notVerified = summaries.filter((s) => !s.consistent);
  const pack = {
    scope: { ns, from, to },
    runs: {
      total: summaries.length,
      closed: summaries.filter((s) => s.outcome && s.outcome !== 'continued-as-new').length,
      open: summaries.filter((s) => s.open).length,
      verified,
      openSigned: summaries.filter((s) => s.open && s.consistent).length,
      notVerified: notVerified.length,
    },
    policies: Object.values(policies),
    certificates: certificates.map((c) => ({ machine: c.subject.machine, buildId: c.buildId, guarantees: c.guarantees, signed: (c.signatures ?? []).map((s) => s.keyId) })),
    rules: byRule,
    oversight: {
      escalations,
      answered,
      unanswered: escalations - answered,
      decisions: human.length,
      approved: human.filter((p) => p.body.action === 'approve').length,
      rejected: human.filter((p) => p.body.action === 'reject').length,
      principalsVerified: human.filter((p) => p.body.principal?.verified).length,
    },
    excluded,
    tamperAlerts: alerts,
    notVerified: notVerified.map((s) => ({ run: s.run, problems: s.problems })),
    disclosure: DISCLOSURE,
  };
  const none = pack.runs.total === 0;
  const recordHolds = none ? null : pack.runs.notVerified === 0 && alerts.length === 0;
  const o = pack.oversight;
  pack.mapping = [
    { framework: 'EU AI Act', item: 'Art. 12 record-keeping', evidence: none ? 'no runs in scope' : `${pack.runs.total} runs recorded as hash-chained ledgers; ${verified} closed and verify end to end, ${pack.runs.openSigned} open and signed so far, ${pack.runs.notVerified} do not verify; ${alerts.length} tamper or gap alert(s)`, holds: recordHolds },
    { framework: 'EU AI Act', item: 'Art. 13 transparency', evidence: none ? 'no runs in scope' : `${pack.policies.length} policy version(s) and ${pack.certificates.length} certificate(s) in force, each with the guarantees it states`, holds: none ? null : pack.policies.length > 0 || pack.certificates.length > 0 },
    {
      framework: 'EU AI Act',
      item: 'Art. 14 human oversight',
      evidence: o.escalations === 0 ? 'no escalation in scope' : `${o.escalations} escalation(s), ${o.answered} decided by a person, ${o.unanswered} never decided; ${o.decisions} human decision(s), ${o.principalsVerified} by a verified principal`,
      // Holds only when every escalation was decided by a person, and every decision by a verified principal.
      holds: o.escalations === 0 ? null : o.unanswered === 0 && o.principalsVerified === o.decisions,
    },
    { framework: 'EU AI Act', item: 'Art. 19/26 log retention', evidence: 'retention is the store\'s configuration, not shown by this pack', holds: null },
    { framework: 'ISO/IEC 42001', item: 'A.6.2.8 event logs', evidence: 'same as Art. 12', holds: recordHolds },
    { framework: 'NIST AI RMF', item: 'MANAGE 2.4 (mechanisms to supersede, disengage)', evidence: `${Object.values(byRule).reduce((a, r) => a + (r.denied ?? 0), 0)} effect(s) refused by a rule before they ran`, holds: null },
  ];
  return pack;
}
