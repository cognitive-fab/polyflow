// The machine host — one SAM v2 strict-profile step, as a pure function.
//
// This is polyrun's `_dispatchInTxn` with the store taken out: rehydrate,
// fire, classify, project, map effects — and polyrun's load-time checks at
// construction. The step kinds (accepted | rejected | unhandled), the window
// and the intent ids match polyrun's, so a journal from either runtime is the
// same trace corpus. Two deliberate differences, both refusals rather than
// approximations: parent/child intents (spawnChild, signalChild) are not
// supported by this host yet and poison with that message; and a mapper that
// throws poisons, where polyrun rolls the step back (in a workflow there is no
// transaction to roll back, and a certified mapper that throws is a defect).
//
// Two properties the Temporal binding depends on:
//
//   1. EVERY call rehydrates (init() + setState()). A SAM module keeps its
//      model in module scope, and the Temporal TS isolate may share module
//      scope between workflow executions. Because each step is synchronous and
//      starts from an explicit snapshot, sharing is harmless: no step can see
//      another run's residue.
//   2. Nothing here reads a clock. Time enters as `now`, which the workflow
//      takes from workflow time, so replay produces the same fire times.
//
// A step that "cannot happen" on a certified machine — a throw, an undeclared
// effect kind, a mutate-then-reject, an unreadable classification — returns
// { poisoned } instead of throwing. The caller quarantines the run; it never
// retries, because a deterministic defect fails the same way every time.

import { sha256hex } from './sha256.mjs';

const ISO_DURATION = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** ISO-8601 duration to ms, with polyrun's civil approximations. null if unparseable. */
export function parseIsoDurationMs(text) {
  const m = ISO_DURATION.exec(text);
  if (!m || text === 'P' || text === 'PT') return null;
  const [, y, mo, w, d, h, min, s] = m.map((v) => (v === undefined ? 0 : Number(v)));
  return (((y * 365 + mo * 30 + w * 7 + d) * 24 + h) * 60 + min) * 60_000 + s * 1000;
}

function resolveFireAt(intent, now) {
  if (typeof intent.fireAt === 'number' && Number.isFinite(intent.fireAt)) return intent.fireAt;
  if (typeof intent.fireInMs === 'number' && Number.isFinite(intent.fireInMs) && intent.fireInMs >= 0) {
    return now + intent.fireInMs;
  }
  if (typeof intent.fireIn === 'string') {
    const ms = parseIsoDurationMs(intent.fireIn);
    if (ms !== null) return now + ms;
    throw new Error(`timer '${intent.key}': unparseable ISO-8601 duration '${intent.fireIn}'`);
  }
  throw new Error(`timer '${intent.key}': needs one of fireIn, fireInMs, fireAt`);
}

/**
 * Does a value fit a contract type? Understands the types contracts use:
 * a union of literals ('a' | 'b' | 3 | true | null), and number, string,
 * boolean, null, and arrays/objects loosely. Anything else is not checked.
 */
function typeProblem(type, value) {
  if (typeof type !== 'string') return null;
  const parts = type.split('|').map((t) => t.trim()).filter(Boolean);
  const fits = (t) => {
    if (/^'.*'$/.test(t) || /^".*"$/.test(t)) return value === t.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(t)) return value === Number(t);
    if (t === 'true' || t === 'false') return value === (t === 'true');
    if (t === 'null') return value === null;
    if (t === 'undefined') return value === undefined;
    if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (t === 'string') return typeof value === 'string';
    if (t === 'boolean') return typeof value === 'boolean';
    if (t.endsWith('[]') || t.startsWith('Array<')) return Array.isArray(value);
    if (t.startsWith('{') || t.startsWith('Record<') || t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    return undefined; // a type this check does not understand
  };
  const verdicts = parts.map(fits);
  if (verdicts.some((v) => v === true || v === undefined)) return null;
  return `holds ${JSON.stringify(value)}, outside its declared type ${type}`;
}

/** The ONE observable-projection rule, shared with polyrun: drop __-keys and functions. */
const project = (raw, keys) => {
  const clean = JSON.parse(JSON.stringify(raw, (k, v) => {
    if (typeof k === 'string' && k.startsWith('__')) return undefined;
    if (typeof v === 'function') return undefined;
    return v;
  }));
  if (!keys) return clean;
  const out = {};
  for (const k of keys) out[k] = clean[k];
  return out;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const isSamV2Module = (mod) => !!mod
  && typeof mod.instance === 'function'
  && typeof mod.init === 'function'
  && typeof mod.getState === 'function'
  && typeof mod.setState === 'function'
  && mod.actions !== null && typeof mod.actions === 'object';

/**
 * @param {object} spec
 * @param {object} spec.module    the SAM v2 module ({instance, init, actions, getState, setState})
 * @param {object} spec.contract  contract.json (stateKeys, initState, terminalStates, terminalKey)
 * @param {Function} [spec.mapper]    effects(pre, action, data, post, stepKind) -> intents
 * @param {object} [spec.manifest]    effects.manifest.json
 */
export function createHost({ module: mod, contract, mapper = null, manifest = null }) {
  if (!isSamV2Module(mod)) {
    throw new Error('module does not export the v2 SAM surface { instance, init, actions, getState, setState }');
  }
  // polyrun's load-time gate: the module must validate strict-clean.
  try {
    const acc = mod.instance({});
    if (typeof acc.validate === 'function') {
      const problems = acc.validate();
      if (Array.isArray(problems) && problems.length > 0) throw new Error(problems.join('; '));
    }
  } catch (err) {
    throw new Error(`module does not validate strict-clean: ${err?.message}`);
  }
  const keys = Array.isArray(contract?.stateKeys) ? contract.stateKeys.map((k) => k.name) : null;
  // Observable-is-total: the snapshot IS the projection, so the module's state
  // and the contract's state keys must coincide, or state is silently lost on
  // every rehydration.
  if (keys) {
    mod.init();
    const modKeys = Object.keys(project(mod.getState(), null));
    const extra = modKeys.filter((k) => !keys.includes(k));
    const missing = keys.filter((k) => !modKeys.includes(k));
    if (extra.length || missing.length) {
      throw new Error('contract stateKeys and module state disagree'
        + (extra.length ? ` — module keys not in contract: ${extra.join(', ')}` : '')
        + (missing.length ? ` — contract keys not in module state: ${missing.join(', ')}` : ''));
    }
  }
  for (const a of Object.keys(contract?.actions ?? {})) {
    if (typeof mod.actions[a] !== 'function') throw new Error(`contract action '${a}' is not exported by the module`);
  }
  const terminalKey = contract?.terminalKey ?? keys?.[0];
  const terminalValues = new Set(contract?.terminalStates ?? []);
  const declared = new Set(Object.keys(manifest?.effects ?? {}));
  const actionNames = new Set(Object.keys(mod.actions));

  // Cross-check the manifest's completion wiring once, at construction: a
  // completion action the machine does not have is a load error, never a
  // runtime surprise.
  for (const [kind, decl] of Object.entries(manifest?.effects ?? {})) {
    for (const hook of ['onSuccess', 'onFailure', 'onExhausted']) {
      const target = decl?.[hook]?.action;
      if (target && !actionNames.has(target)) {
        throw new Error(`manifest effect '${kind}' ${hook} action '${target}' is not in the machine's action surface`);
      }
    }
  }

  const rehydrate = (state) => { mod.init(); if (state) mod.setState(state); };
  const snapshot = () => project(mod.getState(), keys);
  const isTerminal = (state) => terminalValues.has(state?.[terminalKey]);

  function init() {
    rehydrate(null);
    return snapshot();
  }

  /** Fire one action against a snapshot. Never mutates the caller's state object. */
  /**
   * One representation of "absent". A field the contract's domain declares
   * with `null` (a fact the judge abstained on) reaches the machine as null
   * whether the payload left it out or said null: admission explores null,
   * and the machine must see at run time exactly what was explored (P6-P8 review CD).
   */
  function normalise(action, data) {
    const domain = contract?.dataDomain?.[action];
    if (!domain || !data || typeof data !== 'object') return data;
    let out = data;
    for (const [field, values] of Object.entries(domain)) {
      if (Array.isArray(values) && values.includes(null) && out[field] === undefined) {
        if (out === data) out = { ...data };
        out[field] = null;
      }
    }
    return out;
  }

  function fire(state, action, data) {
    data = normalise(action, data);
    let pre;
    try {
      rehydrate(state);
      pre = snapshot();
    } catch (err) {
      return { poisoned: `module rejected the snapshot: ${err?.message}` };
    }
    const handler = mod.actions[action];
    if (typeof handler !== 'function') {
      return { pre, post: pre, stepKind: 'unhandled', reason: `action '${action}' is not in the machine's action surface` };
    }
    try {
      handler(data);
    } catch (err) {
      if (err?.name === 'SamSchemaError') {
        // A schema-invalid payload is the CALLER's error: observable reject.
        return { pre, post: pre, stepKind: 'rejected', reason: err.message };
      }
      return { poisoned: `action '${action}' threw: ${err?.message}` };
    }
    const acc = mod.instance({});
    const step = typeof acc.lastStep === 'function' ? acc.lastStep() : null;
    if (!step || (step.intent !== undefined && step.intent !== null && step.intent !== action)) {
      // Never default an unreadable classification to 'accepted': that would
      // run the mapper for a step the module may have refused.
      return { poisoned: `lastStep() did not classify action '${action}'` };
    }
    if (step.classification === 'rejected') {
      const after = snapshot();
      if (!same(after, pre)) return { poisoned: `acceptor for '${action}' mutated the model and then rejected` };
      return { pre, post: pre, stepKind: 'rejected', reason: step.rejections?.[0]?.reason || 'rejected' };
    }
    if (step.classification === 'unhandled') {
      return { pre, post: pre, stepKind: 'unhandled', reason: `no acceptor handled '${action}'` };
    }
    return { pre, post: snapshot(), stepKind: 'accepted' };
  }

  /**
   * One step.
   * @returns {{stepKind, reason?, pre, post, effects[], timers[], cancelTimers[], terminal}|{poisoned}}
   *   effects: [{ intentId, kind, payload, ordinal }]
   *   timers:  [{ key, fireAt, action, data }]
   */
  function step(state, action, data = {}, { runKey = '', seq = 0, now = 0 } = {}) {
    const r = fire(state, action, data);
    if (r.poisoned) return r;
    const out = { ...r, effects: [], timers: [], cancelTimers: [], terminal: false };
    if (r.stepKind !== 'accepted') return out;
    out.terminal = isTerminal(r.post);
    if (!mapper) return out;

    let intents;
    try {
      intents = mapper(r.pre, action, data, r.post, r.stepKind) || [];
    } catch (err) {
      return { poisoned: `effect mapper threw: ${err?.message}` };
    }
    const timerKeys = new Set();
    let ordinal = 0;
    for (const intent of intents) {
      if (intent.kind === 'timer') {
        if (typeof intent.key !== 'string' || !intent.key) return { poisoned: 'effect mapper emitted a timer without a key' };
        if (timerKeys.has(intent.key)) return { poisoned: `effect mapper emitted duplicate timer key '${intent.key}' in one step` };
        timerKeys.add(intent.key);
        let fireAt;
        try { fireAt = resolveFireAt(intent, now); } catch (err) { return { poisoned: `effect mapper: ${err.message}` }; }
        out.timers.push({ key: intent.key, fireAt, action: intent.action, data: intent.data ?? {} });
      } else if (intent.kind === 'cancelTimer') {
        out.cancelTimers.push(intent.key);
      } else if (intent.kind === 'spawnChild' || intent.kind === 'signalChild') {
        return { poisoned: `effect mapper emitted '${intent.kind}': parent/child machines are not supported by this host yet (compose with child workflows)` };
      } else if (declared.has(intent.kind)) {
        const n = ordinal++;
        out.effects.push({
          // polyrun's derivation, byte for byte: sha256(instance|seq|kind|ordinal)[0:32].
          intentId: sha256hex([runKey, String(seq), intent.kind, String(n)].join('|')).slice(0, 32),
          kind: intent.kind,
          payload: intent.payload ?? {},
          ordinal: n,
        });
      } else {
        return { poisoned: `effect mapper emitted undeclared kind '${intent.kind}'` };
      }
    }
    // A terminal run arms nothing: its timers would only ever be rejected.
    if (out.terminal) out.timers = [];
    return out;
  }

  /**
   * Why this object cannot be the machine's state, or null. It must carry
   * exactly the contract's state keys and survive a rehydration unchanged.
   */
  function checkSnapshot(snap) {
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return 'a state is an object';
    if (keys) {
      const have = Object.keys(snap);
      const missing = keys.filter((k) => !have.includes(k));
      const extra = have.filter((k) => !keys.includes(k));
      if (missing.length || extra.length) return `state keys differ from the contract${missing.length ? ` — missing ${missing.join(', ')}` : ''}${extra.length ? ` — unknown ${extra.join(', ')}` : ''}`;
    }
    // A value outside its declared type (an enum state the machine never
    // reaches, a string where a number goes) is refused before the machine
    // sees it: setState may well accept it (P4/P5 review MG).
    for (const k of contract?.stateKeys ?? []) {
      const why = typeProblem(k.type, snap[k.name]);
      if (why) return `state key '${k.name}' ${why}`;
    }
    try {
      rehydrate(snap);
      if (!same(snapshot(), project(snap, keys))) return 'the machine does not hold this state as given (setState changed it)';
    } catch (err) {
      return `the machine refuses this state: ${err?.message}`;
    }
    return null;
  }

  /** What an Update validator needs: would this action be accepted? Pure; changes nothing observable. */
  function dryRun(state, action, data = {}) {
    const r = fire(state, action, data);
    if (r.poisoned) return { stepKind: 'poisoned', reason: r.poisoned };
    return { stepKind: r.stepKind, reason: r.reason };
  }

  /** The manifest's completion wiring for an effect kind. */
  function completion(kind) {
    return manifest?.effects?.[kind] ?? null;
  }

  /**
   * The completion action for an effect's outcome, as polyrun's workers build
   * it: success -> onSuccess with the result's fields; permanent failure ->
   * onFailure with { reason }; exhausted retries -> onExhausted (else
   * onFailure) with { reason: 'exhausted' }. A hook's `data` overrides, and a
   * hook's `map` picks fields out of { result } / { error }.
   * @returns {{action, data}|null}  null when the manifest wires nothing
   */
  function completionAction(kind, outcome, { result, message } = {}) {
    const decl = completion(kind);
    if (!decl) return null;
    // polyrun: a permanent failure with no onFailure falls through to
    // onExhausted; exhaustion with no onExhausted falls through to onFailure.
    const hook = outcome === 'success' ? decl.onSuccess
      : outcome === 'permanent' ? (decl.onFailure || decl.onExhausted)
        : (decl.onExhausted || decl.onFailure);
    const asFailure = outcome === 'permanent' && Boolean(decl.onFailure);
    if (!hook?.action) return null;
    const context = outcome === 'success' ? { result } : { error: { message } };
    const fallback = outcome === 'success'
      ? (result && typeof result === 'object' ? result : {}) // polyrun: a scalar result carries no fields
      : { reason: asFailure ? String(message ?? 'failed') : 'exhausted' };
    const out = { ...(hook.data || {}) };
    if (hook.map && typeof hook.map === 'object') {
      for (const [field, path] of Object.entries(hook.map)) {
        let v = context;
        for (const part of String(path).replace(/^\$\.?/, '').split('.').filter(Boolean)) { v = v == null ? undefined : v[part]; }
        out[field] = v;
      }
      return { action: hook.action, data: out };
    }
    return { action: hook.action, data: { ...fallback, ...out } };
  }

  return { init, step, dryRun, checkSnapshot, completion, completionAction, isTerminal, keys, actions: [...actionNames] };
}
