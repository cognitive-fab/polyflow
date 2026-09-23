// GovernedWorkflow — G2: a certified SAM machine decides what may happen next;
// the agent (or a worker, or a person) decides how each step is done.
// Technical spec §5.4. Runs INSIDE the workflow isolate.
//
// The only code here is an interpreter. The machine is pure and sealed, so
// there is nothing in it that could make replay diverge: no clock (time enters
// as action data and workflow time), no I/O (every effect is an activity), no
// randomness. A non-determinism error in the machine is impossible by
// construction, not by discipline.
//
// Every proposal — an activity's completion, an Update, a Signal, a timer —
// goes through ONE function, `step`, which is polyrun's dispatch with Temporal
// as the store: rehydrate, fire, classify, record the window, order effects,
// arm timers. A proposal that does not apply is an observable reject with a
// reason, never an error, which is what makes duplicate and stale deliveries
// safe.

import {
  proxyActivities, workflowInfo, condition, setHandler, defineQuery, defineUpdate, defineSignal,
  sleep, CancellationScope, ApplicationFailure, isCancellation, allHandlersFinished, makeContinueAsNewFunc, ActivityCancellationType,
} from '@temporalio/workflow';
import { createHost, digest, verifyPrincipal, principalClaims } from '@cognitive-fab/polyflow-kernel';
import { governorOf } from './governor-registry.mjs';

/** Certified machines bundled into this worker: name -> { module, contract, mapper, manifest, descriptor, certificate? }. */
const registry = new Map();
/** Worker-side configuration, set by the operator in the plugin — never by whoever starts a run. */
let workerOptions = { externalMode: 'never' };

/** Called by the generated interceptor module at bundle load, never by user code. */
export function registerMachines(machines, options = {}) {
  for (const [name, spec] of Object.entries(machines ?? {})) registry.set(name, spec);
  workerOptions = { ...workerOptions, ...options };
}

export const stateQuery = defineQuery('polyflow.state');
export const journalQuery = defineQuery('polyflow.journal');
export const proposeUpdate = defineUpdate('polyflow.propose');
export const proposeSignal = defineSignal('polyflow.propose');
export const releaseUpdate = defineUpdate('polyflow.release');
export const migrateUpdate = defineUpdate('polyflow.migrate');
export const versionSignal = defineSignal('polyflow.version');
export const reportUpdate = defineUpdate('polyflow.report');
export const wakeSignal = defineSignal('polyflow.wake');
export const claimUpdate = defineUpdate('polyflow.claim');

const DEFAULT_LEASE_MS = 10 * 60_000;

const JOURNAL_MAX = 500;       // windows kept in memory for the journal query
const DEDUPE_MAX = 1000;       // actionIds remembered for duplicate suppression
const CLOSED_ORDERS_MAX = 200; // closed orders kept for the state query (review M1)
const HELD_MAX = 1000;         // proposals held while a run is quarantined

const retryOf = (decl) => {
  const r = decl?.retry ?? {};
  return {
    startToCloseTimeout: r.timeoutMs ?? 120_000,
    // Calling an order off waits for the activity to actually stop (or finish):
    // a hand-over that carried an order still running on the old worker would
    // re-issue it on the new one and do the step twice (P11 sample 3 review, B1).
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    // An order that parks (a person's) heartbeats; its heartbeat timeout is also
    // what bounds how soon a cancellation reaches it (the SDK throttles
    // heartbeats to 80% of it, or 30 s without one).
    ...(r.heartbeatMs ? { heartbeatTimeout: r.heartbeatMs } : {}),
    retry: {
      maximumAttempts: r.maxAttempts ?? 3,
      initialInterval: r.baseMs ?? 1000,
      backoffCoefficient: 2,
    },
  };
};

/** A permanent failure is a RESULT (denied, declined), not a fault: onFailure, no retry. */
const isPermanent = (err) => {
  const f = err?.cause ?? err;
  return f?.nonRetryable === true || f?.type === 'PolyflowDenied' || f?.type === 'Permanent';
};

/**
 * @param {object} args
 * @param {string} args.machine      a certified machine bundled into this worker
 * @param {object} [args.input]      creation data, proposed as `inputAction`
 * @param {object} [args.snapshot]   resume from this state (Continue-as-New, migration)
 * @param {number} [args.seq]        the step count carried across Continue-as-New
 * @param {object[]} [args.orders]   open work orders carried across Continue-as-New: re-issued under
 *                                   the SAME order id — at-least-once, as polyrun re-offers a lapsed lease
 * @param {object[]} [args.timers]   armed timers carried across Continue-as-New
 * @param {'worker'|'external'} [args.mode]  worker: each order is an activity; external: each order
 *                                   waits for a report (an MCP agent, a person, another service)
 */
export async function GovernedWorkflow(args = {}) {
  const { machine, input = {} } = args;
  const info = workflowInfo();
  // Everything Continue-as-New carries is accepted ONLY from a Continue-as-New
  // of this very run. From any other start it would hand the run work, timers
  // or state the machine never produced (reviews S2, P4/P5 FO).
  const CARRIED = ['snapshot', 'seq', 'orders', 'timers', 'results', 'held', 'previous', 'claims', 'migration'];
  const continued = Boolean(info.continuedFromExecutionRunId);
  if (!continued) {
    const forged = CARRIED.filter((k) => args[k] !== undefined && args[k] !== null);
    if (forged.length) {
      throw ApplicationFailure.create({
        type: 'PolyflowSnapshotRefused', nonRetryable: true,
        message: `a governed run starts from its machine's initial state; ${forged.join(', ')} ${forged.length > 1 ? 'are' : 'is'} accepted only across Continue-as-New (a snapshot is accepted only across Continue-as-New)`,
      });
    }
  }
  const snapshot = continued ? args.snapshot ?? null : null;
  const carriedSeq = continued ? args.seq ?? 0 : 0;
  const carriedOrders = continued ? args.orders ?? [] : [];
  const carriedTimers = continued ? args.timers ?? [] : [];
  // Who performs orders is the OPERATOR's choice (plugin `externalMode`), not the caller's.
  const requested = args.mode ?? 'worker';
  const mode = workerOptions.externalMode === 'always' ? 'external'
    : workerOptions.externalMode === 'allowed' ? requested : 'worker';
  if (requested === 'external' && mode !== 'external') {
    throw ApplicationFailure.create({ type: 'PolyflowModeRefused', nonRetryable: true, message: "this worker does not accept external-mode runs (its plugin's externalMode is 'never')" });
  }
  const spec = registry.get(machine);
  if (!spec) {
    throw ApplicationFailure.create({
      type: 'PolyflowUnknownMachine', nonRetryable: true,
      message: `machine '${machine}' is not certified on this worker (known: ${[...registry.keys()].join(', ') || 'none'})`,
    });
  }
  const host = createHost(spec);
  const inputAction = spec.descriptor?.inputAction ?? 'START';
  // Order ids are derived from the chain's first run, so a reset or a reused
  // workflow id does not reproduce them; a Continue-as-New keeps them (review C3).
  const runKey = `${info.workflowId}:${info.firstExecutionRunId}`;

  // A state handed in is accepted only from a Continue-as-New of this very
  // run, and only if the machine can hold it: a client that starts a run
  // inside `review` skips every guarantee its certificate states (review S2).
  // A carried state this machine cannot hold (a migration to a new shape that
  // the new version refuses) does not fail the run for good: the run is
  // quarantined holding what it was given, and an operator releases it with a
  // state the machine can hold (P4/P5 review MG).
  const refusedCarry = snapshot ? host.checkSnapshot(snapshot) : null;
  let state = snapshot && !refusedCarry ? snapshot : (snapshot ? (args.previous && !host.checkSnapshot(args.previous) ? args.previous : host.init()) : host.init());
  let seq = carriedSeq;
  let terminal = host.isTerminal(state);
  let poisoned = refusedCarry ? `the carried state cannot be held by '${machine}': ${refusedCarry}` : null;
  let orderSeq = 0;
  const journal = [];
  const results = new Map(continued ? args.results ?? [] : []); // actionId -> step result (duplicate suppression), carried (review CL)
  const orders = new Map();       // orderId -> { orderId, kind, payload, status, attempt }
  const timers = new Map();       // key -> { key, fireAt, action, data, scope }
  const inflight = new Set();     // promises of running work orders
  let pendingMigration = continued && args.migration ? args.migration : null; // a migrated snapshot to continue as new with (carried while it waits for promotion, VG1)
  let handingOver = false;        // set when the hand-over starts: new orders are carried, not started
  // From the start of a hand-over, Updates are refused with this retryable
  // reason: the caller retries and reaches the next execution. Nothing is
  // accepted that the carried state would not contain (P9 review HO1).
  const HANDING_OVER = 'retry: the run is handing over to its next execution (Continue-as-New); send this again';
  const held = continued ? [...(args.held ?? [])] : []; // proposals that arrived while quarantined (review P1), carried
  const stopAction = spec.descriptor?.stopAction ?? null;
  // Completion actions are addressed to an order: only the order's own
  // completion, or a report naming an open order of that kind, may deliver
  // them (review S1).
  const completionKinds = new Map(); // action -> [effect kinds it completes]
  for (const [kind, decl] of Object.entries(spec.manifest?.effects ?? {})) {
    for (const hook of ['onSuccess', 'onFailure', 'onExhausted']) {
      const a = decl?.[hook]?.action;
      if (a) completionKinds.set(a, [...new Set([...(completionKinds.get(a) ?? []), kind])]);
    }
  }

  const record = (w) => {
    journal.push(w);
    if (journal.length > JOURNAL_MAX) journal.shift();
  };

  /** THE write path. Synchronous, so no two proposals ever interleave. */
  function step(action, data, { source, actionId, by = null } = {}) {
    if (actionId && results.has(actionId)) {
      const prior = results.get(actionId);
      // An id reused for a DIFFERENT action is a caller bug, not a duplicate (review D1).
      if (prior.action !== undefined && prior.action !== action) {
        return { stepKind: 'rejected', reason: `actionId '${actionId}' was already used for action '${prior.action}'`, state };
      }
      return { ...prior, deduped: true };
    }
    if (poisoned && action !== stopAction) {
      // Quarantined: nothing is stepped, and nothing is lost. The proposal is
      // journaled as held and replayed, in arrival order, on release (review P1).
      if (held.length < HELD_MAX) held.push({ action, data, source, actionId });
      record({ seq, action, data, pre: state, post: state, stepKind: 'held', rejectReason: `poisoned: ${poisoned}`, actionId: actionId ?? null, source, at: Date.now() });
      return { stepKind: 'held', reason: `poisoned: ${poisoned}`, state };
    }
    if (terminal) {
      const r = { stepKind: 'rejected', reason: 'terminal', state, seq: ++seq };
      record({ seq: r.seq, action, data, pre: state, post: state, stepKind: 'rejected', rejectReason: 'terminal', actionId, source, at: Date.now() });
      return remember(actionId, r);
    }
    const now = Date.now();
    const r = host.step(state, action, data, { runKey, seq: seq + 1, now });
    if (r.poisoned) {
      poisoned = r.poisoned;
      record({ seq: seq + 1, action, data, pre: state, post: state, stepKind: 'poisoned', rejectReason: r.poisoned, actionId, source, at: now });
      return { stepKind: 'poisoned', reason: r.poisoned, state };
    }
    seq += 1;
    record({
      seq, action, data, pre: r.pre, post: r.post, stepKind: r.stepKind,
      rejectReason: r.reason ?? null, actionId: actionId ?? null, source, at: now, ...(by ? { by } : {}),
    });
    if (r.stepKind === 'accepted') {
      state = r.post;
      if (poisoned && action === stopAction) { poisoned = null; held.length = 0; }
      // Orders open BEFORE this step: the ones a terminal step may call off.
      const earlier = [...orders.values()].filter((o) => o.status === 'open');
      for (const key of r.cancelTimers) cancelTimer(key);
      for (const t of r.timers) armTimer(t);
      for (const e of r.effects) order(e);
      if (r.terminal) {
        terminal = true;
        for (const key of [...timers.keys()]) cancelTimer(key);
        // Effects ordered BY the terminal step run, as in polyrun (review T1);
        // work ordered earlier and no longer needed is called off.
        for (const o of earlier) o.scope?.cancel();
      }
    }
    return remember(actionId, { stepKind: r.stepKind, reason: r.reason, state, seq, action });
  }

  function remember(actionId, r) {
    if (actionId) {
      results.set(actionId, r);
      if (results.size > DEDUPE_MAX) results.delete(results.keys().next().value);
    }
    return r;
  }

  /** An effect becomes a work order: an activity named by the effect kind. */
  function order(effect) {
    const decl = host.completion(effect.kind);
    const tool = spec.descriptor?.tools?.[effect.kind] ?? {};
    const o = { orderId: effect.intentId, kind: effect.kind, payload: effect.payload, status: 'open', n: ++orderSeq, tool: tool.tool ?? effect.kind, target: tool.target ?? null, why: tool.why ?? '' };
    o.attempt = effect.attempt ?? 1;
    o.maxAttempts = decl?.retry?.maxAttempts ?? 3;
    o.role = tool.role ?? (tool.performer === 'human' ? 'human' : null);
    o.external = mode === 'external';
    if (effect.claimedBy) { o.claimedBy = effect.claimedBy; o.claimedUntil = effect.claimedUntil; }
    orders.set(o.orderId, o);
    // Closed orders are kept only as far back as the state query needs (review M1).
    const closed = [...orders.values()].filter((x) => x.status !== 'open');
    for (const x of closed.slice(0, Math.max(0, closed.length - CLOSED_ORDERS_MAX))) orders.delete(x.orderId);
    // During the hand-over an order is carried, open, to the next execution,
    // and started there: never started here, then abandoned (P9 review HO1).
    if (handingOver) return;
    // External mode: the order waits for a report (polyflow.report). No
    // activity is scheduled, so the order crosses the guard HERE, the same
    // way an activity would, and is recorded in the ledger (review EX).
    if (mode === 'external') {
      const g = governorOf(info.runId);
      const d = g?.external?.order(tool.activity ?? effect.kind, effect.payload);
      if (d && !d.allowed) {
        o.status = 'failed';
        const c = host.completionAction(effect.kind, 'permanent', { message: d.message });
        if (c) step(c.action, c.data, { source: 'guard', actionId: `${o.orderId}:failed` });
      } else if (d) {
        o.ledger = d; // the effect id to observe against when the report comes
      }
      return;
    }
    // A descriptor may route a kind to a named activity (polyflow.observe for Jev).
    const run = proxyActivities(retryOf(decl))[tool.activity ?? effect.kind];
    // Each order runs in its own scope, so a run that reaches a terminal state
    // can call off the work it no longer needs (a pending approval after the
    // approval window closed, say) instead of waiting on it forever.
    o.scope = new CancellationScope();
    const p = o.scope.run(async () => {
      let completion;
      try {
        const result = await run(effect.payload, { orderId: o.orderId, tool: o.tool, target: o.target, why: o.why, workflowId: runKey, machine });
        o.status = 'done';
        completion = host.completionAction(effect.kind, 'success', { result });
      } catch (err) {
        // Called off at a hand-over, the order stays OPEN: it is carried and re-issued there.
        if (isCancellation(err)) { if (o.status === 'open' && !handingOver) o.status = 'cancelled'; return; }
        const permanent = isPermanent(err);
        o.status = permanent ? 'failed' : 'exhausted';
        completion = host.completionAction(effect.kind, permanent ? 'permanent' : 'exhausted', { message: (err?.cause ?? err)?.message });
      }
      if (o.status === 'reported') return; // already completed by a report naming this order
      if (completion) step(completion.action, completion.data, { source: 'order', actionId: `${o.orderId}:${o.status}` });
    });
    inflight.add(p);
    p.finally(() => inflight.delete(p)).catch(() => {});
  }

  function armTimer({ key, fireAt, action, data }) {
    cancelTimer(key);
    const scope = new CancellationScope();
    const t = { key, fireAt, action, data, scope };
    timers.set(key, t);
    scope.run(async () => {
      try {
        await sleep(Math.max(0, fireAt - Date.now()));
      } catch (err) {
        if (isCancellation(err)) return;
        throw err;
      }
      if (timers.get(key) !== t) return;
      timers.delete(key);
      // A stale timer is not a race to prevent: the machine rejects it, observably.
      step(action, data, { source: 'timer', actionId: `timer:${key}:${fireAt}` });
    }).catch(() => {});
  }

  function cancelTimer(key) {
    const t = timers.get(key);
    if (!t) return;
    timers.delete(key);
    t.scope.cancel();
  }

  // ---- start ---------------------------------------------------------------
  // BEFORE any handler is registered: Temporal delivers buffered Updates and
  // Signals the moment their handler is set, and a report that arrives with the
  // first workflow task must find the orders the start step created.
  if (!snapshot) step(inputAction, input, { source: 'start', actionId: `start:${runKey}` });
  for (const t of carriedTimers) armTimer(t);
  for (const e of carriedOrders) order(e);

  // ---- handlers ----------------------------------------------------------
  setHandler(stateQuery, () => ({
    machine, certificate: spec.descriptor?.certificate ?? null, state, seq, terminal, poisoned,
    orders: [...orders.values()].filter((o) => o.status === 'open').map(({ orderId, kind, payload, tool, target, why, attempt, role, claimedBy, claimedUntil }) => ({
      orderId, kind, args: payload, tool, target, why, attempt, role,
      ...(claimedBy && claimedUntil > Date.now() ? { claimedBy, claimedUntil } : {}),
    })),
    mode,
    done: terminal,
    migrationPending: pendingMigration ? { toBuildId: pendingMigration.toBuildId, onVersionChange: pendingMigration.onVersionChange } : null,
    timers: [...timers.values()].map(({ key, fireAt, action }) => ({ key, fireAt, action })),
  }));
  setHandler(journalQuery, () => journal.slice());
  /**
   * Why an out-of-band proposal may not be stepped, or null. A completion
   * action names the order it completes: an agent (or anyone with a client)
   * cannot answer an order addressed to someone else by proposing its
   * completion bare (review S1). The role check on WHO reports lands with
   * claims (P5); until then the order id is the minimum.
   */
  function outOfBand(action, orderId, actor) {
    const kinds = completionKinds.get(action);
    if (!kinds) return null;
    if (!orderId) return `'${action}' completes an order (${kinds.join(', ')}): report it against the order, with its orderId`;
    const o = orders.get(orderId);
    if (!o || o.status !== 'open') return `order '${orderId}' is not open`;
    if (!kinds.includes(o.kind)) return `'${action}' does not complete a '${o.kind}' order`;
    // An order this worker's activity performs, addressed to nobody, completes
    // when the activity does: a proposal naming it would step the completion
    // while the work is in flight (paid, on the record, before the payment).
    // A person's order (a role) is answered by a proposal, as the parked
    // activity is only the request's presence on the worker (P11 sample 2).
    if (!o.external && !o.role) return `order '${orderId}' is performed by this worker; it is not completed by hand`;
    // The same rules as polyflow.report: a claim, a role (P4/P5 review PC).
    const holder = holderOf(o);
    if (holder && holder !== actorId(actor)) return `order '${orderId}' is claimed by ${holder}`;
    if (o.role && !(Array.isArray(actor?.roles) && actor.roles.includes(o.role))) return `order '${orderId}' is addressed to role '${o.role}'`;
    return null;
  }

  /** A report against an open order: close it, call off its activity, step the completion. */
  function propose(action, data, { source, actionId, orderId, actor }) {
    if (!(actionId && results.has(actionId))) {
      const why = outOfBand(action, orderId, actor);
      if (why) {
        record({ seq, action, data, pre: state, post: state, stepKind: 'refused', rejectReason: why, actionId: actionId ?? null, source, at: Date.now() });
        return { stepKind: 'refused', reason: why, state };
      }
    }
    let role = null;
    if (orderId) {
      const o = orders.get(orderId);
      if (o && o.status === 'open') { o.status = 'reported'; o.scope?.cancel(); }
      role = o?.role ?? null;
      // Same id the worker-side completion would use: the two can never both land.
      actionId = actionId ?? `${orderId}:done`;
    }
    // Who proposed it is part of the record: the journal row carries the actor
    // (a verified principal, or a claim), and the ledger a proposal event, so a
    // person's answer to an order is in the signed chain, not only in Temporal's
    // history (P11 sample 2 review, M1).
    const by = actor ? { id: actorId(actor), verified: Boolean(actor.verified), ...(Array.isArray(actor.roles) ? { roles: actor.roles } : {}) } : null;
    // (A signal's arrival is already a ledger proposal, recorded by the interceptor.)
    if (source !== 'signal') {
      governorOf(workflowInfo().runId)?.record?.('proposal', {
        source: role === 'human' ? 'human' : 'agent',
        action, dataDigest: digest(data), ...(by ? { principal: by } : {}), ...(orderId ? { orderId } : {}),
      });
    }
    return step(action, data, { source, actionId, by });
  }

  /**
   * Who is acting. With a trust store for principals (plugin `principals`,
   * plan P5.5) an actor is a signed token, checked here, in the workflow; its
   * id and roles are then facts. Without one, the actor is a claim, recorded
   * as unverified. Throws the reason a token is refused.
   *
   * With principals configured, EVERY state-changing Update and Signal needs a
   * token, and the token must be signed for THIS action on THIS workflow
   * (`act`): a token lifted from history authorises only the action it already
   * recorded (P9 security SEC-PR1, SEC-AU1).
   */
  function resolveActor(actor, act, { verified = false } = {}) {
    if (!workerOptions.principals) return actor == null ? null : { ...actor, verified: false };
    // In a handler, after the validator verified it: the claims, replay-stable (P9 review RT1).
    if (verified) return actor == null ? null : principalClaims(actor);
    if (actor == null) throw new Error(`refused: ${act.op} needs a verified principal: this worker requires signed principals`);
    const v = verifyPrincipal(actor, { trust: workerOptions.principals, now: Date.now(), audience: workerOptions.audience ?? info.namespace, action: { ...act, wf: info.workflowId } });
    if (!v.ok) throw new Error(`refused: ${v.reason}`);
    return v.principal;
  }
  const needRole = (who, roles, what) => {
    if (workerOptions.principals && !roles.some((r) => who?.roles?.includes(r))) throw new Error(`${what} needs a verified principal with the ${roles.map((r) => `'${r}'`).join(' or ')} role`);
  };

  setHandler(proposeUpdate, ({ action, data = {}, actionId, orderId, actor } = {}) => propose(action, data, { source: 'update', actionId, orderId, actor: resolveActor(actor, { op: 'propose', ref: action, digest: digest(data) }, { verified: true }) }), {
    // The validator is an acceptor dry run, mapper included, on the state the
    // handler will step: a proposal the machine would reject — or that would
    // poison the run — never enters history (review V1). Temporal writes
    // nothing for a rejected Update, so the caller-side mirror records it.
    validator: ({ action, data = {}, actionId, orderId, actor } = {}) => {
      if (handingOver) throw new Error(HANDING_OVER);
      actor = resolveActor(actor, { op: 'propose', ref: action, digest: digest(data) });
      if (typeof action !== 'string' || !action) throw new Error('propose needs an action');
      if (actionId && results.has(actionId)) {
        const prior = results.get(actionId);
        if (prior.action !== undefined && prior.action !== action) throw new Error(`rejected: actionId '${actionId}' was already used for action '${prior.action}'`);
        return; // a duplicate is answered, not refused
      }
      if (poisoned && action !== stopAction) throw new Error(`poisoned: ${poisoned}`);
      if (terminal) throw new Error('rejected: terminal');
      const why = outOfBand(action, orderId, actor);
      if (why) throw new Error(`refused: ${why}`);
      const d = host.step(state, action, data, { runKey, seq: seq + 1, now: Date.now() });
      if (d.poisoned) throw new Error(`refused: this proposal would poison the run (${d.poisoned})`);
      if (d.stepKind !== 'accepted') throw new Error(`rejected: ${d.reason}`);
    },
  });
  setHandler(proposeSignal, ({ action, data = {}, actionId, orderId, actor } = {}) => {
    // A signal has no validator: a refused identity is journaled, not stepped.
    let who;
    // With verified principals a proposal must be an Update: a Signal has no
    // validator, and verifying in its handler would not be replay-stable (RT1).
    try { if (workerOptions.principals) throw new Error('refused: with verified principals, propose with the polyflow.propose Update'); who = resolveActor(actor, { op: 'propose', ref: action }); } catch (err) {
      record({ seq, action, data: {}, pre: state, post: state, stepKind: 'rejected', rejectReason: err.message, actionId: actionId ?? null, source: 'signal', at: Date.now() });
      return;
    }
    // During a hand-over a signal is held, and carried with the rest.
    if (handingOver) { if (held.length < HELD_MAX) held.push({ action, data, source: 'signal', actionId }); return; }
    propose(action, data, { source: 'signal', actionId, orderId, actor: who });
  });
  setHandler(wakeSignal, () => {}); // an activation: a pinned run looks at its target version again
  setHandler(releaseUpdate, ({ snapshot: next, principal = null, reason = '' }) => {
    // An operator releases a quarantined run with a state they vouch for. It
    // is journaled with who and why, and everything held is replayed (review P2).
    const was = poisoned;
    const who = workerOptions.principals ? resolveActor(principal, { op: 'release', run: info.runId }, { verified: true }) : { id: String(principal?.id ?? principal ?? 'unknown'), verified: false };
    record({ seq, action: 'polyflow.release', data: { principal: { id: who.id, verified: who.verified }, reason: String(reason).slice(0, 500), poisoned: was }, pre: state, post: next, stepKind: 'released', rejectReason: null, actionId: null, source: 'operator', at: Date.now() });
    poisoned = null;
    state = next;
    const replay = held.splice(0);
    for (const h of replay) step(h.action, h.data, { source: h.source, actionId: h.actionId });
    return { state, replayed: replay.length };
  }, {
    validator: ({ snapshot: next, force = false, principal = null } = {}) => {
      if (handingOver) throw new Error(HANDING_OVER);
      if (!poisoned) throw new Error('the run is not poisoned');
      // With verified principals, releasing takes the operator role.
      // Bound to this run AND the state released into (P9 review TK1).
      if (workerOptions.principals) needRole(resolveActor(principal, { op: 'release', run: info.runId, to: digest(next) }), ['operator'], 'release');
      const why = host.checkSnapshot(next);
      if (why) throw new Error(`release refused: ${why}`);
      // "Done" is a state the machine reaches, not one an operator declares.
      if (host.isTerminal(next) && !force) throw new Error('release refused: a terminal snapshot ends the run by fiat; pass force with a reason if that is the intent');
    },
  });

  /** Who holds an order right now, if anyone (a lapsed lease holds nothing). */
  const holderOf = (o) => (o.claimedBy && o.claimedUntil > Date.now() ? o.claimedBy : null);
  const actorId = (actor) => (actor && typeof actor.id === 'string' ? actor.id : null);

  setHandler(claimUpdate, ({ orderId, actor }) => {
    // polycrew's protocol, as an Update the workflow orders: a claim is a
    // lease; a refused claim is an ANSWER naming the holder, not an error.
    actor = resolveActor(actor, { op: 'claim', ref: orderId }, { verified: true });
    const o = orders.get(orderId);
    const who = actorId(actor);
    const holder = holderOf(o);
    if (holder && holder !== who) return { claimed: false, holder, orderId, claimedUntil: o.claimedUntil };
    o.claimedBy = who;
    o.claimedUntil = Date.now() + (spec.descriptor?.claimLeaseMs ?? DEFAULT_LEASE_MS);
    record({ seq, action: 'polyflow.claim', data: { orderId, actor: { id: who, verified: Boolean(actor?.verified) } }, pre: state, post: state, stepKind: 'claimed', rejectReason: null, actionId: null, source: 'crew', at: Date.now() });
    return { claimed: true, holder: who, orderId, claimedUntil: o.claimedUntil };
  }, {
    validator: ({ orderId, actor } = {}) => {
      if (handingOver) throw new Error(HANDING_OVER);
      actor = resolveActor(actor, { op: 'claim', ref: orderId });
      const o = orders.get(orderId);
      if (!o || o.status !== 'open') throw new Error(`order '${orderId}' is not open`);
      if (!actorId(actor)) throw new Error('a claim needs an actor');
      // The role check. Roles are facts when principals are verified (plugin
      // `principals`, P5.5), and the caller's claim otherwise.
      if (o.role && !(Array.isArray(actor.roles) && actor.roles.includes(o.role))) {
        throw new Error(`order '${orderId}' is addressed to role '${o.role}'`);
      }
    },
  });

  setHandler(reportUpdate, ({ orderId, ok = true, result = {}, error = '', permanent = false, actor = null }) => {
    actor = resolveActor(actor, { op: 'report', ref: orderId }, { verified: true });
    const o = orders.get(orderId);
    const who = actorId(actor);
    const closeWith = (status, outcome, extra) => {
      o.status = status;
      if (o.ledger) governorOf(info.runId)?.external?.observe(o.ledger, ok, ok ? result : undefined, error);
      const c = host.completionAction(o.kind, outcome, extra);
      if (!c) {
        record({ seq, action: 'polyflow.report', data: { orderId, ok, permanent }, pre: state, post: state, stepKind: 'unwired', rejectReason: `no completion is wired for '${o.kind}' ${outcome}`, actionId: null, source: 'report', at: Date.now() });
        return { stepKind: 'unwired', state, seq };
      }
      return step(c.action, c.data, { source: 'report', actionId: `${orderId}:${status === 'reported' ? 'done' : status}` });
    };
    if (ok) return closeWith('reported', 'success', { result });
    if (permanent) return closeWith('failed', 'permanent', { message: error });
    // A retryable failure re-offers the order until its attempts run out.
    o.attempt += 1;
    o.claimedBy = null;
    if (o.attempt > o.maxAttempts) return closeWith('exhausted', 'exhausted', { message: error });
    // A retry is a step of the run's record: it advances seq, so a caller
    // waiting for the run to move does not wait out its timeout (review GW1).
    seq += 1;
    record({ seq, action: 'polyflow.report', data: { orderId, ok: false, error: String(error).slice(0, 200), attempt: o.attempt, by: who }, pre: state, post: state, stepKind: 'retry', rejectReason: null, actionId: null, source: 'report', at: Date.now() });
    return { stepKind: 'retry', attempt: o.attempt, state, seq };
  }, {
    validator: ({ orderId, ok = true, result = {}, error = '', permanent = false, actor = null } = {}) => {
      if (handingOver) throw new Error(HANDING_OVER);
      const o = orders.get(orderId);
      // Bound to this attempt and this outcome: a token lifted from history cannot
      // report the order again, differently (P9 review PR1).
      actor = resolveActor(actor, { op: 'report', ref: orderId, attempt: o?.attempt, digest: digest({ ok, result, error, permanent }) });
      if (!o || o.status !== 'open') throw new Error(`order '${orderId}' is not open`);
      // An order a worker activity performs is reported by that activity, not
      // by an Update (P4/P5 review RP): only external orders take reports.
      if (!o.external) throw new Error(`order '${orderId}' is performed by this worker; it is not reported by hand`);
      const holder = holderOf(o);
      // Only the holder reports a claimed order (polycrew MA-7).
      if (holder && holder !== actorId(actor)) throw new Error(`order '${orderId}' is claimed by ${holder}`);
      // An order addressed to a role is reported by someone who holds it (review RP/RL).
      if (o.role && !(Array.isArray(actor?.roles) && actor.roles.includes(o.role))) throw new Error(`order '${orderId}' is addressed to role '${o.role}'`);
      if (terminal) throw new Error('rejected: terminal');
    },
  });

  setHandler(migrateUpdate, ({ snapshot: next, toBuildId = null, onVersionChange = false, shapeChange = false, from, principal = null }) => {
    const by = resolveActor(principal, { op: 'migrate', ref: from }, { verified: true });
    // The version gate decided this run moves to the new version with a
    // (possibly migrated) state that polyvers validated over this very state.
    // With Worker Versioning the run waits until the new version is current,
    // then continues as new onto it (Upgrade-on-Continue-as-New); without it,
    // it hands over at once.
    pendingMigration = { snapshot: next, from, toBuildId, onVersionChange: Boolean(onVersionChange), shapeChange: Boolean(shapeChange) };
    record({ seq, action: 'polyflow.migrate', data: { toBuildId, onVersionChange, shapeChange, by: by ? { id: by.id, verified: by.verified } : null }, pre: state, post: next, stepKind: 'migration-pending', rejectReason: null, actionId: null, source: 'version', at: Date.now() });
    return { accepted: true, waitsForVersionChange: Boolean(onVersionChange) };
  }, {
    validator: ({ snapshot: next, from, shapeChange = false, principal = null } = {}) => {
      if (handingOver) throw new Error(HANDING_OVER);
      // A migration replaces the run's state: an operator action, signed for
      // this run and this `from` (P9 security SEC-MG1).
      // Bound to this run, this state AND the target: a token lifted from history
      // cannot move the run anywhere the gate did not decide (P9 review MG1).
      needRole(resolveActor(principal, { op: 'migrate', ref: from, run: info.runId, to: digest(next) }), ['operator', 'migrator'], 'migrate');
      if (terminal) throw new Error('the run is terminal: nothing to migrate');
      // "Done" is a state the machine reaches, never one a migration declares.
      if (host.isTerminal(next)) throw new Error('refused: a migration may not move a run into a terminal state');
      if (poisoned) throw new Error('the run is quarantined: release it first (release checks the state it is given)');
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('migrate needs a snapshot object');
      if (pendingMigration) throw new Error('a migration is already pending');
      // Computed from the state the run is in NOW, or refused: a gate decision
      // read before the run moved on must not rewind it (review MG2).
      if (from !== digest(state)) throw new Error('refused: the migration was computed from a state this run has left (from does not match); vet again');
      // A same-shape migration must be a state this machine can hold; a new
      // shape is checked by the new version, which quarantines a bad one (review MG).
      if (!shapeChange) { const why = host.checkSnapshot(next); if (why) throw new Error(`refused: ${why}`); }
    },
  });
  setHandler(versionSignal, ({ decision, toBuildId = null, reason = null, principal = null } = {}) => {
    // auto-upgrade and pin are recorded where the run's own record can show
    // them — bounded, and with principals only from an operator (SEC-AU1).
    let by;
    try { by = resolveActor(principal, { op: 'version' }); needRole(by, ['operator'], 'version'); } catch (err) {
      record({ seq, action: 'polyflow.version', data: {}, pre: state, post: state, stepKind: 'rejected', rejectReason: err.message, actionId: null, source: 'version', at: Date.now() });
      return;
    }
    if (!['auto-upgrade', 'pin', 'migrate'].includes(decision)) return;
    record({ seq, action: 'polyflow.version', data: { decision, toBuildId: toBuildId == null ? null : String(toBuildId).slice(0, 80), reason: reason == null ? null : String(reason).slice(0, 200), by: by ? { id: by.id, verified: by.verified } : null }, pre: state, post: state, stepKind: 'recorded', rejectReason: null, actionId: null, source: 'version', at: Date.now() });
  });

  /**
   * Continue as new, carrying what is still open: orders are called off here
   * and re-issued there under the same id, timers re-armed at the same fire
   * time. The state carried is the migrated one when a migration is pending.
   */
  /**
   * What the next execution starts from, computed at the LAST moment: inside
   * the Continue-as-New interceptor, after the ledger's closing flush, in the
   * same activation that emits the command. Anything an Update or a Signal
   * stepped while the flush was in flight is therefore carried, never lost
   * (P9 review HO1).
   */
  function carryArgs(upgrade) {
    const open = [...orders.values()].filter((o) => o.status === 'open');
    for (const o of open) o.scope?.cancel();
    for (const key of [...timers.keys()]) { const t = timers.get(key); cancelTimer(key); timers.set(key, t); }
    const carryOrders = open.map(({ orderId, kind, payload, attempt, claimedBy, claimedUntil }) => ({ intentId: orderId, kind, payload, attempt, claimedBy, claimedUntil }));
    const carryTimers = [...timers.values()].filter(Boolean).map(({ key, fireAt, action, data }) => ({ key, fireAt, action, data }));
    let snapshot = state;
    let migration = null;
    if (pendingMigration) {
      if (digest(state) !== pendingMigration.from) {
        // The run moved on after the migration was decided: carry what it holds; the gate re-vets.
        record({ seq, action: 'polyflow.migrate', data: { toBuildId: pendingMigration.toBuildId }, pre: state, post: state, stepKind: 'migration-stale', rejectReason: 'the run moved on after the migration was decided', actionId: null, source: 'version', at: Date.now() });
      } else if (pendingMigration.onVersionChange && !upgrade) {
        // Continue-as-New was suggested while waiting for promotion: stay on this
        // version, on this state, and keep waiting (P9 review VG1).
        migration = pendingMigration;
      } else {
        snapshot = pendingMigration.snapshot;
      }
    }
    return {
      machine, snapshot, previous: state, seq, orders: carryOrders, timers: carryTimers, mode,
      results: [...results.entries()].slice(-200), held: held.slice(0, HELD_MAX), ...(migration ? { migration } : {}),
    };
  }

  async function handOver() {
    handingOver = true;
    // Orders in flight are called off and awaited: an activity that heartbeats
    // stops and is carried open; one that does not runs to its end here, and
    // its completion is stepped on THIS version. Nothing is done twice.
    for (const o of [...orders.values()].filter((x) => x.status === 'open')) o.scope?.cancel();
    await Promise.allSettled([...inflight]);
    // Never hand over with an Update handler mid-flight: its caller would get no answer.
    await condition(allHandlersFinished);
    if (pendingMigration && digest(state) !== pendingMigration.from) {
      // The run moved on while its work was called off: the state the gate
      // vetted is not the state it holds. Stay on this version; the gate re-vets.
      record({ seq, action: 'polyflow.migrate', data: { toBuildId: pendingMigration.toBuildId }, pre: state, post: state, stepKind: 'migration-stale', rejectReason: 'the run moved on after the migration was decided', actionId: null, source: 'version', at: Date.now() });
      pendingMigration = null;
      if (!workflowInfo().continueAsNewSuggested) { handingOver = false; return; }
    }
    // Onto the new version when the gate said so and Worker Versioning made it current.
    const upgrade = Boolean(pendingMigration?.onVersionChange && workflowInfo().targetWorkerDeploymentVersionChanged);
    const entry = governorOf(info.runId);
    if (entry) entry.finalizeHandOver = () => carryArgs(upgrade);
    // The placeholder is replaced by carryArgs() after the closing flush (interceptor);
    // without the interceptor (no plugin), it is computed here.
    await (upgrade ? makeContinueAsNewFunc({ initialVersioningBehavior: 'AUTO_UPGRADE' }) : makeContinueAsNewFunc({}))(entry ? { machine } : carryArgs(upgrade));
  }

  // ---- run -----------------------------------------------------------------

  for (;;) {
    const migrationReady = () => pendingMigration !== null && (!pendingMigration.onVersionChange || workflowInfo().targetWorkerDeploymentVersionChanged);
    await condition(() => terminal || poisoned !== null || migrationReady() || workflowInfo().continueAsNewSuggested);
    if (terminal) break;
    if (poisoned !== null) {
      // Quarantined: never retried, visible, released only by an operator.
      await condition(() => poisoned === null || terminal);
      continue;
    }
    if (pendingMigration && !migrationReady() && !workflowInfo().continueAsNewSuggested) continue;
    await handOver();
  }
  // Let completions of orders still running land as observable rejects rather than vanish.
  await Promise.allSettled([...inflight]);
  return { machine, state, seq };
}
