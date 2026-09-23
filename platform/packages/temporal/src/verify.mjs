// Offline verification of a run's ledger — FR-LED.3.
//
// Needs no network, no Temporal and no vendor service: the events, the signed
// heads and a trust store. An auditor who did not produce the record can run
// it. It answers four separate questions, because they are different claims:
//
//   chain       — is the sequence internally consistent (no edit, drop, reorder)?
//   signatures  — did a trusted key vouch for heads of this chain?
//   covered     — does a trusted, anchored head cover the LAST event? Anything
//                 after the last signed head is unauthenticated: anyone can
//                 append correctly chained events, genesis is public (review V2).
//   closed      — does the record end in a closure? Without one, a truncated
//                 ledger and an unfinished run look the same (review V1).
//
// `allowOpen` accepts a run with no closure yet (in progress), and says so.
// `unsigned` accepts a history-derived ledger (polyflow export) with no heads,
// as a DIFFERENT verdict: consistent, not vouched for.

import { verifyChain } from '@cognitive-fab/polyflow-kernel';
import { verifyHead } from './sink.mjs';

export function verifyBundle({ events, heads = [], trust = {}, allowOpen = false, unsigned = false }) {
  const report = { ok: false, verdict: 'broken', chain: null, signatures: [], anchored: 0, signedThrough: null, closed: false, problems: [] };
  report.chain = verifyChain(events);
  if (!report.chain.ok) {
    report.problems.push(`chain breaks at seq ${report.chain.seq}: ${report.chain.reason}`);
    return report;
  }
  const run = events[0].run;
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  for (const h of heads) {
    const sameRun = h.run?.ns === run.ns && h.run?.wf === run.wf && h.run?.run === run.run;
    const sig = sameRun ? verifyHead(h, trust) : { ok: false, reason: 'head belongs to another run' };
    const at = bySeq.get(h.seq);
    const anchored = Boolean(at && at.hash === h.hash);
    report.signatures.push({ seq: h.seq, keyId: h.keyId, ok: sig.ok, anchored, reason: sig.reason });
    if (!sig.ok) report.problems.push(`head at seq ${h.seq}: ${sig.reason}`);
    else if (!anchored) report.problems.push(`signed head at seq ${h.seq} does not match the event at that seq`);
    else report.anchored++;
  }
  const good = report.signatures.filter((s) => s.ok && s.anchored).map((s) => s.seq);
  report.signedThrough = good.length ? Math.max(...good) : null;
  // A continued-as-new closure hands the chain on; only a final one ends it.
  report.closed = events.some((e) => e.kind === 'closure' && e.body?.outcome !== 'continued-as-new');
  const last = report.chain.head.seq;

  if (unsigned) {
    if (!report.closed && !allowOpen) report.problems.push('no closure: the record is unfinished or truncated');
    report.ok = report.problems.length === 0;
    report.verdict = report.ok ? 'consistent-unsigned' : 'not-ok';
    return report;
  }
  if (report.signedThrough === null) report.problems.push('no trusted signed head anchors this chain');
  else if (report.signedThrough < last) report.problems.push(`seq ${report.signedThrough + 1}..${last} are not covered by any trusted signed head: anyone could have appended them`);
  if (!report.closed && !allowOpen) report.problems.push('no closure: the record is unfinished or truncated');
  report.ok = report.problems.length === 0;
  report.verdict = report.ok ? (report.closed ? 'closed-and-signed' : 'open-and-signed') : 'not-ok';
  return report;
}
