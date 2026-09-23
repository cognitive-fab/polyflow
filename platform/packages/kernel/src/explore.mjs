// Exhaustive exploration of a machine over its contract's declared domain —
// the structural half of admission (FR-ADM.5; technical spec §7.1 step 3).
//
// polygraph's check-effects answers "what may be EMITTED on every path". The
// structural checks answer questions about the state graph itself, which
// check-effects does not: can every reachable state still finish? does every
// state that waits on a person arm a timer? is there always a way to stop?
//
// Exhaustive over the declared (action, data) domain and nothing else. A walk
// that hits its state ceiling reports `bounded`, and bounded is not a pass.

import { canonical } from './canonical.mjs';

/** Every (action, data) pair the contract declares: the cartesian product of each action's field values. */
export function domainOf(contract) {
  const out = [];
  for (const action of Object.keys(contract.actions ?? {})) {
    const fields = contract.dataDomain?.[action] ?? {};
    let combos = [{}];
    for (const [field, values] of Object.entries(fields)) {
      const vs = Array.isArray(values) ? values : [values];
      combos = combos.flatMap((c) => vs.map((v) => ({ ...c, [field]: v })));
    }
    for (const data of combos) out.push({ action, data });
  }
  return out;
}

/**
 * Breadth-first over accepted steps.
 * @returns {{ states: Map<string, object>, edges: object[], bounded: boolean, poisoned: object[] }}
 */
export function explore(host, contract, { maxStates = 20_000 } = {}) {
  const domain = domainOf(contract);
  const init = host.init();
  const key = (s) => canonical(s);
  const states = new Map([[key(init), init]]);
  const edges = [];
  const poisoned = [];
  const unexplored = new Set(); // reached but never expanded: the walk stopped first
  let frontier = [init];
  let bounded = false;
  while (frontier.length) {
    const next = [];
    for (const s of frontier) {
      if (host.isTerminal(s)) continue;
      for (const { action, data } of domain) {
        const r = host.step(s, action, data, { runKey: 'explore', seq: 0, now: 0 });
        if (r.poisoned) { poisoned.push({ state: s, action, data, reason: r.poisoned }); continue; }
        if (r.stepKind !== 'accepted') continue;
        const k = key(r.post);
        edges.push({ from: key(s), to: k, action, data, effects: r.effects.map((e) => e.kind), timers: r.timers.map((t) => t.key), timerActions: r.timers.map((t) => t.action) });
        if (!states.has(k)) {
          if (states.size >= maxStates) { bounded = true; unexplored.add(key(s)); continue; }
          states.set(k, r.post);
          next.push(r.post);
        }
      }
    }
    frontier = next;
    if (bounded) { for (const s of frontier) unexplored.add(key(s)); break; }
  }
  return { states, edges, bounded, poisoned, unexplored, init: key(init) };
}

/**
 * The structural checks.
 * @param {object} o
 * @param {object} o.host        createHost(...)
 * @param {object} o.contract
 * @param {object} [o.descriptor]  polyflow.workflow.json: tools{kind:{performer?}}, stopAction?
 * @returns {{ items: {name, ok, detail}[], bounded, statesSeen }}
 */
export function structuralChecks({ host, contract, descriptor = {}, maxStates, stateInvariants = [] }) {
  const g = explore(host, contract, { maxStates });
  const items = [];

  // 1. Every reachable non-terminal state can still reach a terminal one.
  const reverse = new Map();
  for (const e of g.edges) {
    if (!reverse.has(e.to)) reverse.set(e.to, new Set());
    reverse.get(e.to).add(e.from);
  }
  const canFinish = new Set([...g.states].filter(([, s]) => host.isTerminal(s)).map(([k]) => k));
  const queue = [...canFinish];
  while (queue.length) {
    const k = queue.pop();
    for (const p of reverse.get(k) ?? []) if (!canFinish.has(p)) { canFinish.add(p); queue.push(p); }
  }
  // A state the walk never expanded is not stuck, it is unknown: when the walk
  // is bounded, liveness is "not established", never a false failure (review AB).
  const stuck = [...g.states].filter(([k, s]) => !host.isTerminal(s) && !canFinish.has(k) && !g.unexplored.has(k)).map(([, s]) => s);
  items.push({
    name: 'every-state-can-finish', ok: g.bounded && !stuck.length ? null : stuck.length === 0,
    detail: stuck.length ? { stuck: stuck.slice(0, 5) } : g.bounded ? 'not established: the walk was bounded' : undefined,
  });

  // 0. The state invariants hold in every reachable state (review IN).
  const broken = [];
  for (const [, s] of g.states) {
    for (const inv of stateInvariants) {
      let ok;
      try { ok = inv.pred(s); } catch { ok = false; }
      if (!ok) broken.push({ invariant: inv.name, state: s });
    }
  }
  items.push({ name: 'state-invariants', ok: broken.length === 0, detail: broken.length ? { violations: broken.slice(0, 5) } : { checked: stateInvariants.map((i) => i.name) } });

  // 2. A step that hands work to a PERSON arms a timer in the same step: a
  //    wait with no deadline is a run that can hang forever (MA-11).
  const human = new Set(Object.entries(descriptor.tools ?? {}).filter(([, t]) => t?.performer === 'human').map(([k]) => k));
  const untimed = g.edges.filter((e) => e.effects.some((k) => human.has(k)) && e.timers.length === 0);
  items.push({
    name: 'waits-on-people-arm-timers', ok: untimed.length === 0,
    detail: untimed.length ? { steps: untimed.slice(0, 5).map(({ action, data, effects }) => ({ action, data, effects })) } : { humanKinds: [...human] },
  });

  // 3. A stop is always available (FR-HUM.6, EU AI Act Art. 14) — when the
  //    descriptor names its stop action. Not naming one is reported, not passed.
  if (descriptor.stopAction) {
    // A state may be declared unstoppable — typically one with an irreversible
    // effect in flight — but only by name and with a reason, and the exception
    // is carried into the certificate rather than passed silently.
    const unstoppable = descriptor.unstoppable ?? {};
    const controlKey = contract.terminalKey ?? contract.stateKeys?.[0]?.name;
    const excepted = (s) => Object.prototype.hasOwnProperty.call(unstoppable, s[controlKey]);
    const noStop = [...g.states].filter(([, s]) => !host.isTerminal(s) && !excepted(s))
      .filter(([, s]) => { const r = host.step(s, descriptor.stopAction, {}); return r.stepKind !== 'accepted' || !r.terminal; })
      .map(([, s]) => s);
    items.push({
      name: 'stop-from-every-state', ok: noStop.length === 0,
      detail: noStop.length ? { states: noStop.slice(0, 5) } : { exceptions: unstoppable },
    });
    // An exception is a claim about the machine, not a licence: a state
    // declared unstoppable must refuse the stop, observably, or the reason in
    // the certificate describes a stop that would have been accepted (P11
    // sample 2 review, M6).
    const stoppable = [...g.states].filter(([, s]) => !host.isTerminal(s) && excepted(s))
      .filter(([, s]) => host.step(s, descriptor.stopAction, {}).stepKind === 'accepted')
      .map(([, s]) => s);
    if (Object.keys(unstoppable).length) {
      items.push({
        name: 'unstoppable-states-refuse-stop', ok: stoppable.length === 0,
        detail: stoppable.length ? { states: stoppable.slice(0, 5) } : { exceptions: Object.keys(unstoppable) },
      });
    }
  } else if (descriptor.noStop) {
    // No STOP, accepted by name and with a reason (recorded in the certificate).
    items.push({ name: 'stop-from-every-state', ok: true, detail: { exceptions: { '*': descriptor.noStop } } });
  } else {
    // FR-HUM.6 (EU AI Act Art. 14): a governed run can always be stopped. A
    // machine that names no stop action is refused (P4/P5 review SA).
    items.push({ name: 'stop-from-every-state', ok: false, detail: 'the descriptor names no stopAction (or a `noStop` reason)' });
  }

  // 5. Every wait has an exit somebody actually sends (P4/P5 review WT).
  //    What can move a state is not "any action in the domain": it is the
  //    completion of an order open when the state was entered, or a timer
  //    armed on the way in. A non-terminal state none of whose incoming
  //    stimuli it accepts waits for a message nobody sends: it is stranded.
  //    (STOP is not counted: liveness must not depend on somebody pressing it.)
  const manifest = host.completion ? host : null;
  const completionsOf = (kind) => {
    const d = manifest?.completion(kind);
    return d ? ['onSuccess', 'onFailure', 'onExhausted'].map((h) => d[h]?.action).filter(Boolean) : [];
  };
  const incoming = new Map();
  for (const e of g.edges) {
    if (!incoming.has(e.to)) incoming.set(e.to, { stimuli: new Set(), deadlines: new Set(), orders: new Set() });
    const into = incoming.get(e.to);
    for (const k of e.effects) { into.orders.add(k); for (const a of completionsOf(k)) into.stimuli.add(a); }
    for (const a of e.timerActions ?? []) { into.stimuli.add(a); into.deadlines.add(a); }
  }
  const exits = new Map();
  for (const e of g.edges) {
    if (!exits.has(e.from)) exits.set(e.from, new Set());
    exits.get(e.from).add(e.action);
  }
  const inputAction = descriptor.inputAction ?? 'START';
  const stranded = [];
  const undeadlined = [];
  for (const [k, s] of g.states) {
    if (host.isTerminal(s) || g.unexplored.has(k)) continue;
    const into = incoming.get(k) ?? { stimuli: new Set(k === g.init ? [inputAction] : []), deadlines: new Set(), orders: new Set() };
    if (k === g.init) into.stimuli.add(inputAction);
    const out = exits.get(k) ?? new Set();
    if (![...into.stimuli].some((a) => out.has(a))) stranded.push({ state: s, waitsFor: [...into.stimuli] });
    // Every OUTCOME of every order open here must be heard here: a failed post
    // that the posting state refuses strands the run as surely as no exit at
    // all (P9 review WT1). A kind with no wiring for an outcome is the same.
    for (const kind of into.orders) {
      const d = manifest?.completion(kind);
      if (!d) continue;
      const outcomes = {
        success: d.onSuccess?.action,
        failure: (d.onFailure ?? d.onExhausted)?.action,
        exhausted: (d.onExhausted ?? d.onFailure)?.action,
      };
      for (const [outcome, action] of Object.entries(outcomes)) {
        if (!action || !out.has(action)) stranded.push({ state: s, order: kind, outcome, waitsFor: action ?? '(nothing wired)' });
      }
    }
    // A wait on an order has a deadline when a timer armed on the way in is accepted here.
    if (into.orders.size && ![...into.deadlines].some((a) => out.has(a))) undeadlined.push({ state: s, orders: [...into.orders] });
  }
  items.push({
    name: 'every-wait-has-an-exit', ok: g.bounded && !stranded.length ? null : stranded.length === 0,
    detail: stranded.length ? { stranded: stranded.slice(0, 5) } : undefined,
  });
  // Informational for worker-performed orders (an activity has its own
  // timeouts); required for a worker that lets agents or people perform
  // orders (externalMode), where an order is a wait with no clock at all.
  items.push({
    name: 'order-waits-have-deadlines', ok: undeadlined.length === 0 ? true : null,
    detail: undeadlined.length ? { withoutDeadline: undeadlined.slice(0, 5).map((u) => ({ state: u.state, orders: u.orders })), count: undeadlined.length } : undefined,
  });

  // 4. Nothing the machine does on a certified path should be impossible.
  items.push({ name: 'no-poisoned-steps', ok: g.poisoned.length === 0, detail: g.poisoned.length ? g.poisoned.slice(0, 5) : undefined });

  return { items, bounded: g.bounded, statesSeen: g.states.size, edges: g.edges.length };
}
