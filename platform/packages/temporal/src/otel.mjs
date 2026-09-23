// OpenTelemetry attributes for governed effects — FR-OBS.1; technical spec §12.
//
// The OTel GenAI conventions are still in development, so the platform does
// not depend on an OTel SDK: it turns ledger events into span attributes a
// customer's own tracer attaches (through the exporter's `onEvents` hook).
// Workflow-side spans are never emitted: they would be emitted again on
// replay. The attributes travel on the ledger, which is replay-safe.

/** Attributes for one effect, from the events of the delta that carried it. */
export function spanAttributes(events) {
  const out = [];
  const verdicts = new Map(events.filter((e) => e.kind === 'verdict').map((e) => [e.body.proposal, e.body]));
  const admission = events.find((e) => e.kind === 'admission')?.body;
  for (const e of events.filter((x) => x.kind === 'effect')) {
    const v = verdicts.get(e.body.proposal) ?? {};
    out.push({
      name: `polyflow ${e.body.activityType ?? e.body.kind}`,
      attributes: {
        'polyflow.run.workflow_id': e.run.wf,
        'polyflow.run.chain': e.run.run,
        'polyflow.ledger.seq': e.seq,
        'polyflow.ledger.hash': e.hash,
        'polyflow.effect.kind': e.body.kind,
        'polyflow.effect.class': e.body.class,
        'polyflow.proposal.id': e.body.proposal,
        'polyflow.verdict': v.outcome ?? 'allowed',
        'polyflow.rules': (v.rules ?? []).join(','),
        ...(admission?.level ? { 'polyflow.level': admission.level } : {}),
        ...(admission?.policy ? { 'polyflow.policy.digest': admission.policy.digest } : {}),
        ...(e.body.approval ? { 'polyflow.approval': e.body.approval } : {}),
      },
    });
  }
  for (const v of events.filter((x) => x.kind === 'verdict' && x.body.outcome !== 'allowed')) {
    out.push({ name: `polyflow ${v.body.outcome}`, attributes: { 'polyflow.run.workflow_id': v.run.wf, 'polyflow.ledger.seq': v.seq, 'polyflow.verdict': v.body.outcome, 'polyflow.rules': (v.body.rules ?? []).join(','), 'polyflow.proposal.id': v.body.proposal } });
  }
  return out;
}
