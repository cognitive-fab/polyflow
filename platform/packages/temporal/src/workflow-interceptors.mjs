// Workflow-side interceptors — run INSIDE the Temporal workflow isolate.
//
// Technical spec §5.2. Everything here is pure: it reads workflow time
// (Date.now() is workflow time inside the isolate), the recorded inputs of the
// calls it intercepts, and frozen configuration. It does no I/O. On replay it
// recomputes the same ledger, the same hashes and the same verdicts, which is
// why it costs CPU on replay and never an extra billable Action.
//
// The ledger rides on the headers of ACTIVITIES the workflow was going to
// schedule anyway. An ActivityTaskScheduled event persists its headers, so the
// decision record becomes part of Temporal's own server-ordered history at no
// extra event, and the activity-side exporter (plugin.mjs) ships it. What has
// no carrier yet — a trailing observation, a denial that scheduled nothing, the
// closure — goes out on flush activities when the execution closes.
//
// Three rules the P0/P1 review (docs/platform/reviews/P0-P1-review.md) made
// explicit, each because breaking it corrupted either replay or the record:
//
//   1. A workflow TASK failure (a TypeError: fixable by redeploying) issues no
//      command of ours. Only a real workflow close — a TemporalFailure, a
//      return, a Continue-as-New — flushes. Otherwise the fixed code would no
//      longer replay (D1).
//   2. Our bookkeeping never changes the workflow's outcome: a flush that
//      fails is swallowed, and the missing closure is what a verifier then
//      reports (D2).
//   3. A chain is keyed by the run that started it, and handed forward only
//      by Continue-as-New. Retries, cron runs and resets start their own (L1).

import {
  workflowInfo, proxyActivities, CancellationScope, upsertMemo, ApplicationFailure, ContinueAsNew,
  TemporalFailure, condition, setHandler, defineQuery, defineUpdate,
} from '@temporalio/workflow';
import { defaultPayloadConverter } from '@temporalio/common';
import { openLedger, digest, redact, verifyPrincipal, principalClaims, sealHeader, openHeader } from '@cognitive-fab/polyflow-kernel';
import { LEDGER_HEADER, HEAD_HEADER, FLUSH_ACTIVITY } from '@cognitive-fab/polyflow-verify/constants';
import { registerGovernor, forgetGovernor, governorOf } from './governor-registry.mjs';

export { LEDGER_HEADER, HEAD_HEADER, FLUSH_ACTIVITY };
const GATE_WORKFLOWS = new Set(['PolyflowGateWorkflow', 'PolyflowPolicyGateWorkflow']);

export const pendingQuery = defineQuery('polyflow.pending');
/** The guard's state, for the policy ramp gate (P4.6). */
export const guardQuery = defineQuery('polyflow.guard');
export const approveUpdate = defineUpdate('polyflow.approve');

const toPayload = (v) => defaultPayloadConverter.toPayload(v);
const fromPayload = (p) => (p ? defaultPayloadConverter.fromPayload(p) : undefined);

/** Flush attempts at close before giving up (each drains everything pending). */
const CLOSE_FLUSHES = 3;

/**
 * Digest of call arguments that may not be canonical JSON (undefined, Dates,
 * class instances). The ledger never stores arguments, only what they were.
 * Lossy by design (Map/Set/class instances collapse); it identifies, it does
 * not reconstruct.
 */
export function argsDigest(args) {
  try {
    return digest(JSON.parse(JSON.stringify(args ?? null) ?? 'null'));
  } catch {
    return 'sha256:unhashable';
  }
}

/** Failure text for the record: redacted before it is written, then truncated. */
const failureText = (err) => redact((err?.cause ?? err)?.message ?? err ?? 'failed', 200);

/**
 * The per-run governor at G0 (observe) records every effect and allows it.
 * G1 (guard) replaces it; see ./guard-governor.mjs.
 */
export function observeOnly() {
  return {
    level: 'observe',
    admission: () => ({ level: 'observe', policy: null }),
    classify: (activityType) => ({ kind: activityType, class: 'unlabelled', labels: [], declared: true }),
    decide: () => ({ outcome: 'allow', rules: [] }),
    observe: () => {},
  };
}

/**
 * Build the `interceptors` export for a workflow module.
 * @param {object} config  frozen plugin configuration (JSON)
 * @param {(config) => object} makeGovernor  per-run governor factory
 */
export function makeInterceptors(config, makeGovernor = observeOnly) {
  return () => {
    const governor = makeGovernor(config);
    let ledger = null;
    let resume = null;        // { run, seq, hash } handed over by Continue-as-New
    let closed = false;       // after the closure is out, nothing more is recorded
    let flushing = false;     // true only while THIS plugin schedules its own flush
    const pending = new Map(); // approvalId -> escalation awaiting a principal

    const open = () => {
      if (ledger) return ledger;
      const info = workflowInfo();
      if (resume) {
        ledger = openLedger({ run: resume.run, head: { seq: resume.seq, hash: resume.hash } });
      } else {
        ledger = openLedger({ run: { ns: info.namespace, wf: info.workflowId, run: info.runId } });
        ledger.append('admission', { ...governor.admission(), execution: { runId: info.runId, attempt: info.attempt } }, Date.now());
      }
      return ledger;
    };

    const append = (kind, body, at = Date.now()) => (closed ? null : open().append(kind, body, at));

    /**
     * A header body, sealed under the worker's data key when one is configured
     * (plan P2.6): payload codecs do not run on headers, so without a key the
     * ledger would sit in history in plaintext.
     */
    const sealed = (value, purpose, seq) => {
      if (!config.headerKey) return value;
      if (!config.headerKey.key) throw new Error(`header key '${config.headerKey.keyId}' is not in this bundle: build it through the PolyflowPlugin (the key is injected at bundle time, never written to source)`);
      return sealHeader(value, config.headerKey, { runId: workflowInfo().runId, purpose, seq });
    };

    /** Attach everything not yet carried to an outgoing activity's headers. */
    const carry = (headers) => {
      const l = open();
      const events = l.drain();
      if (events.length === 0) return headers;
      return { ...headers, [LEDGER_HEADER]: toPayload(sealed({ events, head: l.head() }, 'ledger', l.head().seq)) };
    };

    /** The plugin's own flush. Marked by a closure-private flag, never by name alone (review G1). */
    const flushOnce = () => {
      const run = proxyActivities({ startToCloseTimeout: '1 minute', retry: { maximumAttempts: 5 } })[FLUSH_ACTIVITY];
      flushing = true;
      try {
        return run({ head: open().head() });
      } finally {
        flushing = false; // scheduleActivity ran synchronously inside run()
      }
    };

    /**
     * Carry everything still pending, looping in case one flush carries less
     * than everything (the closure is out and `closed` is set before this runs,
     * so nothing lands during the flush; a late result or signal is refused or
     * dropped, never recorded after the closure).
     * Never throws: bookkeeping must not change the workflow's outcome (D2).
     */
    const drainAll = async () => {
      for (let i = 0; i < CLOSE_FLUSHES && open().pending() > 0; i++) {
        try {
          await CancellationScope.nonCancellable(() => flushOnce());
        } catch {
          return false;
        }
      }
      return open().pending() === 0;
    };

    /** End this execution's part of the record. */
    const close = async (outcome) => {
      // One flush carries the trailing events and the closure together. The
      // closure is this execution's last event: from here on nothing is recorded.
      append('closure', { outcome });
      closed = true;
      const carried = await drainAll();
      if (carried && config.memo !== false) upsertMemo({ polyflow: { head: open().head() } });
    };

    // A handler still running after the workflow function continued-as-new or
    // returned (Temporal warns: TMPRL1102) would make an effect this execution's
    // record cannot hold, the closure being its last event. Refused, so nothing
    // happens off the record.
    const refuseClosed = (target) => ApplicationFailure.create({
      type: 'PolyflowDenied', nonRetryable: true,
      message: `'${target}' after this execution closed: an effect with no record is refused`,
      details: [{ rules: [], allowedNow: [] }],
    });

    const deny = (pid, rules, message, witness, at, extra = {}) => {
      append('verdict', { proposal: pid, outcome: 'denied', rules, witness: witness ?? null, reason: message, ...extra }, at);
      return ApplicationFailure.create({
        type: 'PolyflowDenied',
        nonRetryable: true,
        message,
        details: [witness ?? { rules: rules.map((id) => ({ id, fix: message })), allowedNow: [] }],
      });
    };

    /**
     * Park an escalated effect until a principal decides it, in workflow time.
     * Returns the decision, or null if nobody answered within the policy's timeout.
     */
    async function escalate(pid, c, d, args) {
      const approvalId = `ap-${pid}`; // derived from the ledger seq: replay names the same approval
      const timeoutMs = governor.policy?.escalation?.timeoutMs ?? 24 * 3600_000;
      const role = governor.policy?.escalation?.role ?? 'approver';
      pending.set(approvalId, {
        // The approver sees the exact arguments the parked call will run with
        // (plan P5.6): an approval is for THIS call, and nothing else runs on it.
        approvalId, kind: c.kind, target: c.target, argsDigest: c.argsDigest, args: args ?? null,
        rules: d.rules, message: d.message, role, requestedAt: c.at, decision: null,
      });
      append('verdict', { proposal: pid, outcome: 'escalated', rules: d.rules, approvalId, role, reason: d.message }, c.at);
      try {
        const answered = await condition(() => pending.get(approvalId).decision !== null, timeoutMs);
        return answered ? pending.get(approvalId) : null;
      } finally {
        // Answered, timed out, or abandoned by a cancelled scope: nothing is left
        // in the inbox for a principal to approve after the fact (review G8).
        pending.delete(approvalId);
      }
    }

    // Local activities retried after a timer backoff re-enter the interceptor
    // with attempt > 1. That is Temporal retrying ONE effect, not a new one
    // (tech spec §6.3; review G7). The first attempt carries no schedule time,
    // so the effect is found by what backed off: its type and argument digest.
    const localEffects = new Map(); // `${activityType}|${argsDigest}` -> { eid, kind, labels, seq } awaiting a retry
    const localKey = (input) => `${input.activityType}|${argsDigest(input.args)}`;

    async function retriedLocal(input, next) {
      const first = localEffects.get(localKey(input));
      try {
        const result = await next(input);
        localEffects.delete(localKey(input));
        append('observation', { effect: first.eid, ok: true, attempt: input.attempt, resultDigest: argsDigest(result) });
        governor.observe({ type: 'observation', kind: first.kind, labels: first.labels, ok: true, result, at: Date.now(), seq: first.seq });
        return result;
      } catch (err) {
        if (err?.name !== 'LocalActivityDoBackoff') {
          localEffects.delete(localKey(input));
          append('observation', { effect: first.eid, ok: false, attempt: input.attempt, error: failureText(err) });
          governor.observe({ type: 'observation', kind: first.kind, labels: first.labels, ok: false, at: Date.now(), seq: first.seq });
        }
        throw err;
      }
    }

    /** Record an outgoing effect, decide it, and either carry it out or refuse it. */
    async function governed(via, input, next) {
      const info = workflowInfo();
      const at = Date.now();
      const target = input.activityType ?? input.workflowType ?? input.operation ?? via;
      if (closed) throw refuseClosed(target);
      const cls = governor.classify(target, input);
      const aDigest = argsDigest(input.args ?? input.input);
      const proposal = append('proposal', { source: 'workflow', action: target, dataDigest: aDigest }, at);
      const pid = `p${proposal.seq}`; // unique within the chain, across Continue-as-New (review L5)
      const c = { kind: cls.kind, class: cls.class, labels: cls.labels ?? [], declared: cls.declared !== false, ...(cls.routed ? { routed: true } : {}), target, argsDigest: aDigest, at, via, proposal: pid };
      let d = governor.decide(c);
      if (d.outcome === 'escalate') {
        // The call is FROZEN as the approver sees it: a copy, taken now, is what
        // runs after the approval. The workflow may edit its own objects while
        // the call waits; that no longer changes the call (P9 review AP1).
        if (Array.isArray(input.args)) input = { ...input, args: JSON.parse(JSON.stringify(input.args)) };
        const answer = await escalate(pid, c, d, input.args ?? input.input);
        const now = Date.now();
        if (!answer) {
          throw deny(pid, d.rules, `escalation ap-${pid}: no decision within ${governor.policy.escalation.timeoutMs} ms (${d.message})`, d.witness, now);
        }
        if (answer.decision !== 'approve') {
          throw deny(pid, d.rules, `escalation ap-${pid}: rejected by ${answer.principal?.id ?? 'unknown'}${answer.note ? ` — ${answer.note}` : ''}`, d.witness, now);
        }
        governor.grant({ id: answer.approvalId, kind: c.kind, argsDigest: c.argsDigest, proposal: pid, principal: answer.principal?.id ?? null, at: now });
        d = governor.decide({ ...c, at: now });
        // Approved, then denied by something that changed while it waited: the
        // approval dies with the effect it was granted for (review G3).
        if (d.outcome !== 'allow') governor.voidApproval?.(answer.approvalId);
      }
      if (d.outcome !== 'allow') {
        throw deny(pid, d.rules, d.message ?? `denied by ${d.rules.join(', ')}`, d.witness, Date.now());
      }
      append('verdict', { proposal: pid, outcome: 'allowed', rules: d.rules, ...(d.approval ? { approval: d.approval } : {}), ...(d.note ? { note: d.note } : {}) });
      governor.commit?.(c, d);
      const eid = `e${open().head().seq + 1}`; // the effect event's own seq
      const guardSeq = governor.state?.().seq;   // the guard's commit seq for this effect, when there is a guard
      append('effect', {
        id: eid, proposal: pid, kind: cls.kind, class: cls.class, via, activityType: target, ...(cls.route ? { route: cls.route } : {}), argsDigest: aDigest,
        // The execution's own run id: unique across retries and Continue-as-New (review L5).
        idempotencyKey: `${info.workflowId}/${info.runId}/${via}/${input.seq}`,
        ...(d.approval ? { approval: d.approval } : {}),
      });
      governor.observe({ type: 'effect', kind: cls.kind, class: cls.class, target, at });
      const observe = (ok, result, err) => {
        // A local activity's backoff is not its outcome: the retry reports that.
        if (!ok && err?.name === 'LocalActivityDoBackoff') {
          localEffects.set(localKey(input), { eid, kind: cls.kind, labels: c.labels, seq: guardSeq });
          return;
        }
        append('observation', ok
          ? { effect: eid, ok: true, resultDigest: argsDigest(result) }
          : { effect: eid, ok: false, error: failureText(err) });
        governor.observe({ type: 'observation', kind: cls.kind, labels: c.labels, ok, result, at: Date.now(), seq: guardSeq });
      };
      // Only activities carry: their headers reach the activity-side exporter.
      // A child-workflow start header would reach history but never the sink (review L2).
      const headers = via === 'activity' ? carry(input.headers) : input.headers;
      if (via === 'child-workflow') {
        // next() resolves at once to [started, completed]: observe the CHILD's
        // outcome when it settles, not the scheduling (review L3).
        let pair;
        try {
          pair = await next({ ...input, headers });
        } catch (err) {
          observe(false, undefined, err);
          throw err;
        }
        pair[1].then((r) => observe(true, r), (err) => observe(false, undefined, err));
        pair[0].catch((err) => observe(false, undefined, err));
        return pair;
      }
      try {
        const result = await next({ ...input, headers });
        observe(true, result);
        return result;
      } catch (err) {
        observe(false, undefined, err);
        throw err;
      }
    }

    /**
     * Orders performed OUTSIDE the worker (GovernedWorkflow external mode) cross
     * the same guard an activity would, synchronously, when they are issued
     * (P4/P5 review EX). An order the guard would escalate is refused here:
     * escalation needs a workflow-time wait the order path does not have, so an
     * external order needing approval is modelled as a human step in the machine.
     */
    const external = {
      order(target, payload) {
        if (closed) throw refuseClosed(target);
        const at = Date.now();
        const cls = governor.classify(target, { activityType: target, args: [payload] });
        const aDigest = argsDigest([payload]);
        const proposal = append('proposal', { source: 'workflow', action: target, dataDigest: aDigest }, at);
        const pid = `p${proposal.seq}`;
        const c = { kind: cls.kind, class: cls.class, labels: cls.labels ?? [], declared: cls.declared !== false, target, argsDigest: aDigest, at, via: 'external', proposal: pid };
        const d = governor.decide(c);
        if (d.outcome !== 'allow') {
          const message = d.outcome === 'escalate'
            ? `external order '${target}' needs approval (${d.message}); model the approval as a step of the machine`
            : d.message ?? `denied by ${d.rules.join(', ')}`;
          append('verdict', { proposal: pid, outcome: 'denied', rules: d.rules, witness: d.witness ?? null, reason: message }, at);
          return { allowed: false, message, rules: d.rules };
        }
        append('verdict', { proposal: pid, outcome: 'allowed', rules: d.rules, ...(d.approval ? { approval: d.approval } : {}) });
        governor.commit?.(c, d);
        const eid = `e${open().head().seq + 1}`;
        const info = workflowInfo();
        append('effect', { id: eid, proposal: pid, kind: cls.kind, class: cls.class, via: 'external', activityType: target, argsDigest: aDigest, idempotencyKey: `${info.workflowId}/${info.runId}/external/${eid}` });
        governor.observe({ type: 'effect', kind: cls.kind, class: cls.class, target, at });
        return { allowed: true, eid, kind: cls.kind, labels: c.labels, seq: governor.state?.().seq };
      },
      observe(ref, ok, result, error) {
        append('observation', ok ? { effect: ref.eid, ok: true, resultDigest: argsDigest(result) } : { effect: ref.eid, ok: false, error: String(error ?? '').slice(0, 200) });
        governor.observe({ type: 'observation', kind: ref.kind, labels: ref.labels, ok, result, at: Date.now(), seq: ref.seq });
      },
    };

    const outbound = {
      async scheduleActivity(input, next) {
        if (flushing && input.activityType === FLUSH_ACTIVITY) return next({ ...input, headers: carry(input.headers) });
        // The platform's own gate workflows run their I/O as activities; they are
        // the operator's machinery, not an agent's effects, and a fail-closed
        // policy must not deny them. Only inside those workflows (never an agent's).
        if (GATE_WORKFLOWS.has(workflowInfo().workflowType) && String(input.activityType).startsWith('polyflow.gate.')) return next(input);
        return governed('activity', input, next);
      },
      async scheduleLocalActivity(input, next) {
        // Local activities record a marker, not their headers: nothing rides here.
        if (input.attempt > 1 && localEffects.has(localKey(input))) return retriedLocal(input, next);
        return governed('local-activity', input, next);
      },
      async signalWorkflow(input, next) {
        // A signal to another workflow is an effect like any other (FR-GRD.1;
        // review G1): one workflow signalling another is an obvious way around a policy.
        return governed('signal', { ...input, activityType: `signal:${input.signalName}` }, (i) => next({ ...input, headers: i.headers }));
      },
      async startNexusOperation(input, next) {
        return governed('nexus', { ...input, activityType: `nexus:${input.service}/${input.operation}` }, (i) => next({ ...input, headers: i.headers }));
      },
      async startChildWorkflowExecution(input, next) {
        return governed('child-workflow', input, next);
      },
      async continueAsNew(input, next) {
        // The chain is handed over, not restarted: close this execution's part,
        // then give the next execution the head and the chain's identity.
        await close('continued-as-new');
        const l = open();
        const guard = governor.state?.() ?? null;
        // A governed run computes what it carries NOW, after the flush (P9 review HO1).
        const finalize = governorOf(workflowInfo().runId)?.finalizeHandOver;
        if (finalize) input = { ...input, args: [finalize()] };
        return next({ ...input, headers: { ...input.headers, [HEAD_HEADER]: toPayload(sealed({ run: l.run, ...l.head(), ...(guard ? { guard } : {}) }, 'head', l.head().seq)) } });
      },
    };

    /** A signed principal, checked against the operator's trust store, or an error naming why not. */
    // Signed for THIS decision: the approval, its run, the decision and the
    // arguments digest the approver saw (P9 security SEC-PR1).
    const verifiedPrincipal = (token, act) => {
      const info = workflowInfo();
      const v = verifyPrincipal(token, { trust: config.principals, now: Date.now(), audience: config.audience ?? info.namespace, action: { ...act, wf: info.workflowId, run: info.runId } });
      if (!v.ok) throw new Error(`refused: ${v.reason}`);
      return v.principal;
    };

    /** The two handlers a principal uses to answer an escalation. */
    const installHandlers = () => {
      setHandler(guardQuery, () => ({ level: governor.level, policy: governor.policy?.digest ?? null, guard: governor.state?.() ?? null, at: Date.now() }));
      setHandler(pendingQuery, () => [...pending.values()].filter((p) => p.decision === null)
        .map(({ decision, ...p }) => p));
      setHandler(approveUpdate, ({ approvalId, decision, principal, note }) => {
        const p = pending.get(approvalId);
        p.decision = decision;
        // With a trust store (plugin `principals`, P5.5) the principal is a
        // signed token the validator verified; otherwise a name in a payload
        // is a claim, not an identity, and is recorded as unverified (§5.7).
        p.principal = config.principals
          ? principalClaims(principal) // verified by the validator at acceptance; replay-stable (RT1)
          : { id: String(principal?.id ?? principal ?? 'unknown'), verified: false };
        p.note = note ? redact(note, 500) : undefined;
        append('proposal', {
          source: 'human', principal: p.principal, action: decision, approvalId,
          ...(p.note ? { note: p.note } : {}),
        });
        return { approvalId, decision };
      }, {
        validator: ({ approvalId, decision, principal, argsDigest: seen } = {}) => {
          const p = pending.get(approvalId);
          if (!p) throw new Error(`no pending escalation '${approvalId}'`);
          // An approver who names the arguments they saw approves exactly those.
          if (seen !== undefined && seen !== p.argsDigest) throw new Error(`escalation '${approvalId}' is for arguments ${p.argsDigest}; you approved ${seen}`);
          if (config.principals) {
            const who = verifiedPrincipal(principal, { op: 'approve', ref: approvalId, decision, argsDigest: p.argsDigest });
            if (!who.roles.includes(p.role)) throw new Error(`escalation '${approvalId}' is decided by role '${p.role}'; ${who.id} does not hold it`);
          }
          if (p.decision !== null) throw new Error(`escalation '${approvalId}' is already decided`);
          if (decision !== 'approve' && decision !== 'reject') throw new Error("decision must be 'approve' or 'reject'");
        },
      });
    };

    const inbound = {
      async handleSignal(input, next) {
        // A signal is an event the guard can see (never-after rules), and a
        // proposal in the record, whatever the workflow does with it.
        append('proposal', { source: 'signal', action: input.signalName, dataDigest: argsDigest(input.args) });
        governor.signal?.(input.signalName, Date.now());
        return next(input);
      },
      async execute(input, next) {
        // Accept a handed-over head only from a real Continue-as-New: a client
        // could otherwise start a run mid-chain with no admission (review M4).
        if (workflowInfo().continuedFromExecutionRunId) {
          const carried = fromPayload(input.headers?.[HEAD_HEADER]);
          // The head was sealed by the execution we continue from, as its purpose 'head'.
          // A plaintext head is accepted: it comes from an execution that ran before
          // sealing was switched on, and a head is only ever read across a real
          // Continue-as-New, so it authenticates nothing a sealed one would (P9 review SH1).
          resume = carried ? openHeader(carried, config.headerKeys ?? {}, { required: false, expect: { runId: workflowInfo().continuedFromExecutionRunId, purpose: 'head' } }) : null;
        }
        if (resume?.guard) governor.restore?.(resume.guard);
        open();
        installHandlers();
        // Workflow code (proposePlan) reaches the guard and the ledger through this.
        const runId = workflowInfo().runId;
        registerGovernor(runId, { governor, record: (kind, body) => append(kind, body), external });
        let result;
        try {
          result = await next(input);
        } catch (err) {
          if (err instanceof ContinueAsNew) throw err; // closed in continueAsNew
          // Only a TemporalFailure closes the workflow. Anything else fails the
          // workflow TASK, which an operator fixes by redeploying: we must add
          // no command, or the fixed code would not replay (review D1).
          if (!(err instanceof TemporalFailure)) throw err;
          await close(err.name === 'CancelledFailure' ? 'cancelled' : 'failed');
          forgetGovernor(runId);
          throw err;
        }
        await close('completed');
        forgetGovernor(runId);
        return result;
      },
    };

    return { inbound: [inbound], outbound: [outbound] };
  };
}
