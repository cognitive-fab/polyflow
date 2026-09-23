// Generates conformance/machine.json: the kernel machine host (createHost:
// init, step, dryRun, checkSnapshot, completionAction, isTerminal) over the
// customer-brief and refund-triage examples, computed by the TypeScript
// kernel. Every other host of a certified SAM machine (the Python plugin's
// QuickJS host first, plan P7.4 / spike P0.6) must reproduce each result
// exactly, as JSON: step kind, reason, pre/post state, effects with their
// intent ids, timers, terminal flag.
//
// Each case is a sequence of operations. A `step` continues from the previous
// step's post state unless it gives its own `state`. Data is stored as JSON
// text so no loader can reinterpret it; an ABSENT field is absent from the text.
import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHost } from '../packages/kernel/src/index.mjs';

const require = createRequire(import.meta.url);
const PLATFORM = new URL('../', import.meta.url);
// Where each machine lives, relative to platform/. The conformance fixtures are
// copies of customer-brief with ONE change each (P9 review QJ1-QJ3).
const DIRS = {
  'customer-brief': 'examples/customer-brief',
  'refund-triage': 'examples/refund-triage',
  'template-require': 'conformance/machines/template-require',
  'clock-reader': 'conformance/machines/clock-reader',
  'mapper-throws': 'conformance/machines/mapper-throws',
};

// Workflow time, as the Temporal TS workflow isolate gives it: Date.now() and
// new Date() read the time of the workflow task. Here that is each op's `now`.
const RealDate = Date;
let WORKFLOW_NOW = 0;
globalThis.Date = class WorkflowDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(WORKFLOW_NOW); else super(...a); }
  static now() { return WORKFLOW_NOW; }
};

function load(name) {
  const dir = new URL(`${DIRS[name]}/`, PLATFORM);
  const json = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf-8'));
  return {
    module: require(new URL('machine.cjs', dir).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    contract: json('contract.json'),
    mapper: require(new URL('effects.cjs', dir).pathname.replace(/^\/([A-Za-z]:)/, '$1')).effects,
    manifest: json('effects.manifest.json'),
  };
}

const J = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function run(host, ops) {
  let state = null;
  return ops.map((op) => {
    let result;
    WORKFLOW_NOW = op.now ?? 0;
    switch (op.op) {
      case 'init':
        result = host.init();
        state = result;
        break;
      case 'step': {
        const from = op.state ?? state;
        const data = op.data === undefined ? undefined : JSON.parse(op.data);
        result = host.step(from, op.action, data, { runKey: op.runKey ?? 'run-1', seq: op.seq ?? 0, now: op.now ?? 0 });
        if (!result.poisoned) state = result.post;
        break;
      }
      case 'dryRun':
        result = host.dryRun(op.state ?? state, op.action, op.data === undefined ? undefined : JSON.parse(op.data));
        break;
      case 'checkSnapshot':
        result = host.checkSnapshot(op.snap);
        break;
      case 'completionAction':
        result = host.completionAction(op.kind, op.outcome, { result: op.result, message: op.message });
        break;
      case 'isTerminal':
        result = host.isTerminal(op.state ?? state);
        break;
      default:
        throw new Error(`unknown op ${op.op}`);
    }
    return { ...op, expect: J(result) ?? null };
  });
}

const S = (action, data, extra = {}) => ({ op: 'step', action, ...(data === undefined ? {} : { data: JSON.stringify(data) }), ...extra });

// A deterministic PRNG, so the random walks are the same every time.
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function walks(contract, count, length, seed) {
  const rnd = prng(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const actions = [...Object.keys(contract.actions), 'NOT_AN_ACTION'];
  const out = [];
  for (let w = 0; w < count; w++) {
    const ops = [{ op: 'init' }];
    for (let i = 0; i < length; i++) {
      const action = pick(actions);
      const domain = contract.dataDomain?.[action] ?? {};
      const data = {};
      for (const [field, values] of Object.entries(domain)) {
        if (rnd() < 0.2) continue; // absent
        data[field] = pick(values);
      }
      ops.push(S(action, rnd() < 0.1 ? undefined : data, { runKey: `walk-${seed}-${w}`, seq: i + 1, now: 1_000_000 + i * 60_000 }));
    }
    out.push({ name: `random walk ${w}`, ops });
  }
  return out;
}

function completions(manifest) {
  const ops = [];
  for (const kind of [...Object.keys(manifest.effects), 'not_a_kind']) {
    ops.push({ op: 'completionAction', kind, outcome: 'success', result: { count: 3, facts: { reason_stated: true, fraud_signal: false } } });
    ops.push({ op: 'completionAction', kind, outcome: 'success', result: 'scalar' });
    ops.push({ op: 'completionAction', kind, outcome: 'permanent', message: 'upstream said no' });
    ops.push({ op: 'completionAction', kind, outcome: 'exhausted', message: 'timed out' });
  }
  return ops;
}

const machines = {
  'customer-brief': {
    cases: [
      { name: 'happy path', ops: [{ op: 'init' },
        S('START', {}, { seq: 1 }), S('TICKETS_READY', { count: 3 }, { seq: 2 }), S('DRAFT_READY', {}, { seq: 3, now: 5000 }),
        S('APPROVED', {}, { seq: 4 }), S('POST_DONE', {}, { seq: 5 }), { op: 'isTerminal' }] },
      { name: 'rejections and unhandled', ops: [{ op: 'init' },
        S('APPROVED', {}, { seq: 1 }), S('NOT_AN_ACTION', {}, { seq: 2 }), S('START', {}, { seq: 3 }), S('START', {}, { seq: 4 }),
        S('POST_DONE', {}, { seq: 5 }), { op: 'dryRun', action: 'TICKETS_READY', data: '{"count":3}' }, { op: 'dryRun', action: 'APPROVED', data: '{}' },
        { op: 'dryRun', action: 'NOPE', data: '{}' }] },
      { name: 'empty brief is denied', ops: [{ op: 'init' }, S('START', undefined, { seq: 1 }), S('TICKETS_READY', { count: 0 }, { seq: 2 }), { op: 'isTerminal' }] },
      { name: 'timer on review, stop', ops: [{ op: 'init' }, S('START', {}, { seq: 1 }), S('TICKETS_READY', { count: 3 }, { seq: 2 }),
        S('DRAFT_READY', {}, { seq: 3, now: 1_700_000_000_000 }), S('STOP', {}, { seq: 4 }), S('STOP', {}, { seq: 5 })] },
      { name: 'snapshots', ops: [
        { op: 'checkSnapshot', snap: { briefState: 'review', ticketCount: 3, reason: '' } },
        { op: 'checkSnapshot', snap: { briefState: 'review', ticketCount: 3 } },
        { op: 'checkSnapshot', snap: { briefState: 'review', ticketCount: 3, reason: '', extra: 1 } },
        { op: 'checkSnapshot', snap: [] },
        { op: 'checkSnapshot', snap: { briefState: 'nowhere', ticketCount: 3, reason: '' } },
        { op: 'isTerminal', state: { briefState: 'posted', ticketCount: 3, reason: '' } }] },
      { name: 'completion actions', ops: completions(load('customer-brief').manifest) },
    ],
  },
  'refund-triage': {
    cases: [
      { name: 'judge clears the refund', ops: [{ op: 'init' },
        S('START', { message: 'my order arrived broken, please refund' }, { runKey: 'rt-1', seq: 1 }),
        S('ASSESSED', { reasonStated: true, fraud: false }, { runKey: 'rt-1', seq: 2 }), S('REFUNDED', {}, { runKey: 'rt-1', seq: 3 }), { op: 'isTerminal' }] },
      { name: 'an absent fact is null (normalise)', ops: [{ op: 'init' },
        S('START', { message: 'my order arrived broken, please refund' }, { seq: 1 }),
        S('ASSESSED', { reasonStated: true }, { seq: 2, now: 42 }), S('APPROVED', {}, { seq: 3 }), S('REFUND_FAILED', { reason: 'card-declined' }, { seq: 4 })] },
      { name: 'a person declines, then stale completions', ops: [{ op: 'init' },
        S('START', { message: 'x' }, { seq: 1 }), S('ASSESS_FAILED', { reason: 'judge-unavailable' }, { seq: 2 }), S('DECLINED', {}, { seq: 3 }),
        S('REFUNDED', {}, { seq: 4 }), S('CANCEL', {}, { seq: 5 }), S('ASSESSED', { reasonStated: null, fraud: null }, { seq: 6 })] },
      { name: 'unicode message', ops: [{ op: 'init' }, S('START', { message: 'réfund \u{1F4E6} please' }, { runKey: 'ré', seq: 1 })] },
      { name: 'a lone surrogate in the run key (the intent id hashes U+FFFD)', ops: [{ op: 'init' }, S('START', { message: 'x' }, { runKey: `lone${String.fromCharCode(0xd800)}key`, seq: 1 })] },
      { name: 'snapshots', ops: [
        { op: 'checkSnapshot', snap: { phase: 'reviewing', message: 'm', route: '', reason: '' } },
        { op: 'checkSnapshot', snap: { phase: 'reviewing', message: 3, route: '', reason: '' } },
        { op: 'checkSnapshot', snap: { phase: 'teleported', message: 'm', route: '', reason: '' } }] },
      { name: 'completion actions', ops: completions(load('refund-triage').manifest) },
    ],
  },
  // QJ1: a template-literal require (a package, and a local module) loads and steps.
  'template-require': {
    cases: [
      { name: 'happy path through the review timer', ops: [{ op: 'init' },
        S('START', {}, { seq: 1 }), S('TICKETS_READY', { count: 3 }, { seq: 2 }), S('DRAFT_READY', {}, { seq: 3, now: 5000 }),
        S('APPROVED', {}, { seq: 4 }), S('POST_DONE', {}, { seq: 5 })] },
    ],
  },
  // QJ2: acceptors read the clock; in a workflow that is workflow time.
  'clock-reader': {
    cases: [
      { name: 'Date.now() is workflow time', ops: [{ op: 'init' },
        S('START', {}, { seq: 1, now: 1700000000123 }), S('STOP', {}, { seq: 2, now: 1700000060000 })] },
      { name: 'the same step at another time', ops: [{ op: 'init' }, S('START', {}, { seq: 1, now: 42 })] },
      { name: 'dry run and snapshot at time 0', ops: [{ op: 'init' }, { op: 'dryRun', action: 'START', data: '{}' },
        { op: 'checkSnapshot', snap: { briefState: 'gathering', ticketCount: 0, reason: 'started@0' } }] },
    ],
  },
  // QJ3: a mapper that throws is a poison (quarantine), whatever its message says.
  'mapper-throws': {
    cases: [
      { name: "'interrupted' in the message", ops: [{ op: 'init' }, S('START', { fail: true }, { seq: 1 }), { op: 'dryRun', action: 'START', data: '{"fail":true}' }] },
      { name: "'out of memory' in the message", ops: [{ op: 'init' }, S('START', {}, { seq: 1 }), S('TICKETS_READY', { count: 3 }, { seq: 2 })] },
      { name: "'stack overflow' in the message", ops: [{ op: 'init' }, S('START', {}, { seq: 1 }), S('TICKETS_READY', { count: 5 }, { seq: 2 }), S('DRAFT_READY', {}, { seq: 3 })] },
    ],
  },
};
const WALKS = new Set(['customer-brief', 'refund-triage', 'clock-reader']);

const out = { version: 1, rule: 'kernel createHost over the machine in dirs[<machine>] (relative to platform/); each op continues from the previous step\'s post state; Date is workflow time (the op\'s now)', dirs: DIRS, machines: {} };
let n = 0;
for (const [name, spec] of Object.entries(machines)) {
  const host = createHost(load(name));
  const cases = [...spec.cases, ...(WALKS.has(name) ? walks(load(name).contract, 12, 10, name.length * 7919) : [])];
  out.machines[name] = cases.map((c) => ({ name: c.name, ops: run(host, c.ops) }));
  n += cases.reduce((a, c) => a + c.ops.length, 0);
}
writeFileSync(new URL('./machine.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${n} operations`);
