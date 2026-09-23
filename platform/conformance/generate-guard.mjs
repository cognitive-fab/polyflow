// Generates conformance/guard.json and conformance/ledger.json from the
// TypeScript kernel. Every other implementation of the guard and the ledger
// (the Python port first) must reproduce, byte for byte: each decision's
// outcome, rules and approval; the digest of the guard state after every
// operation; and every ledger hash.
//
// Policies are stored ADMITTED (normalised, with their digest): admission runs
// once, in CI, in the TypeScript toolchain. Workers in any language load the
// admitted artefact and only decide.
import { writeFileSync } from 'node:fs';
import { admitPolicy, createGuard, classify, digest, openLedger } from '../packages/kernel/src/index.mjs';

const policies = {
  comms: {
    policy: 'comms', version: 1,
    effects: {
      fetch_url: { kind: 'fetch', class: 'none', labels: ['reads-untrusted'] },
      read_crm: { kind: 'read', class: 'none', labels: ['reads-private'] },
      ask_approval: { kind: 'approval', class: 'none' },
      slack_send: { kind: 'post', class: 'irreversible', labels: ['egress'] },
      send_email: { kind: 'email', class: 'irreversible', labels: ['egress'] },
      redact: { kind: 'redact', class: 'none' },
      llm: { kind: 'model', class: 'none' },
    },
    unlabelled: 'report',
    rules: [
      { id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' },
      { id: 'at-most-two-posts', type: 'at-most', guards: 'post', n: 2 },
      { id: 'no-post-after-cancel', type: 'never-after', guards: 'post', after: { signal: 'CANCEL' } },
      { id: 'trifecta', type: 'trifecta', declassify: 'redact', outcome: 'escalate' },
      { id: 'draft-before-email', type: 'implies-prior', guards: 'email', prior: 'model' },
      { id: 'tool-calls', type: 'budget', metric: 'effects', max: 12 },
      { id: 'tokens', type: 'budget', metric: 'tokens', from: 'usage.total_tokens', max: 1000, kinds: ['model'] },
      { id: 'post-rate', type: 'rate', guards: 'post', n: 1, perMs: 10000 },
    ],
    escalation: { role: 'approver', timeoutMs: 60000 },
  },
  strict: {
    policy: 'strict', version: 2,
    effects: { send_email: { kind: 'email', class: 'irreversible', labels: ['egress'] }, llm: { kind: 'model', class: 'none' } },
    unlabelled: 'escalate',
    rules: [
      { id: 'approve-each-email', type: 'requires-prior', guards: 'email', prior: 'model', bind: 'per-effect' },
      { id: 'calls', type: 'budget', metric: 'effects', max: 3 },
    ],
    escalation: { role: 'approver', timeoutMs: 1000 },
  },
};

// Operation scripts. `activity` is classified through the policy exactly as
// the interceptor does; `args` is digested with the canonical digest.
const scripts = {
  comms: [
    { op: 'decide-commit', activity: 'slack_send', at: 1000, args: { text: 'a' }, proposal: 'p1' },
    { op: 'decide-commit', activity: 'ask_approval', at: 2000, args: {}, proposal: 'p2' },
    { op: 'observe', activity: 'ask_approval', ok: true },
    { op: 'decide-commit', activity: 'slack_send', at: 3000, args: { text: 'a' }, proposal: 'p3' },
    { op: 'observe', activity: 'slack_send', ok: true },
    { op: 'decide-commit', activity: 'ask_approval', at: 4000, args: {}, proposal: 'p4' },
    { op: 'observe', activity: 'ask_approval', ok: true },
    { op: 'decide-commit', activity: 'slack_send', at: 5000, args: { text: 'b' }, proposal: 'p5' },
    { op: 'decide-commit', activity: 'fetch_url', at: 20000, args: { url: 'x' }, proposal: 'p6' },
    { op: 'observe', activity: 'fetch_url', ok: false },
    { op: 'decide-commit', activity: 'read_crm', at: 21000, args: { id: 1 }, proposal: 'p7' },
    { op: 'observe', activity: 'read_crm', ok: true },
    { op: 'decide-commit', activity: 'llm', at: 22000, args: { q: 1 }, proposal: 'p8' },
    { op: 'observe', activity: 'llm', ok: true, result: { usage: { total_tokens: 700 } } },
    { op: 'decide-commit', activity: 'send_email', at: 23000, args: { to: 'x' }, proposal: 'p9' },
    { op: 'grant', id: 'ap-p9', activity: 'send_email', args: { to: 'x' }, proposal: 'p9', at: 24000 },
    { op: 'decide-commit', activity: 'send_email', at: 24000, args: { to: 'x' }, proposal: 'p9' },
    { op: 'decide-commit', activity: 'redact', at: 25000, args: {}, proposal: 'p10' },
    { op: 'observe', activity: 'redact', ok: true },
    { op: 'decide-commit', activity: 'send_email', at: 26000, args: { to: 'y' }, proposal: 'p11' },
    { op: 'decide-commit', activity: 'llm', at: 27000, args: { q: 2 }, proposal: 'p12' },
    { op: 'observe', activity: 'llm', ok: true, result: { usage: { total_tokens: -5 } } },
    { op: 'decide-commit', activity: 'llm', at: 28000, args: { q: 3 }, proposal: 'p13' },
    { op: 'signal', name: 'CANCEL', at: 29000 },
    { op: 'decide-commit', activity: 'mystery_tool', at: 30000, args: {}, proposal: 'p14' },
    { op: 'decide-commit', activity: 'ask_approval', at: 31000, args: {}, proposal: 'p15' },
    { op: 'observe', activity: 'ask_approval', ok: true },
    { op: 'decide-commit', activity: 'slack_send', at: 45000, args: { text: 'c' }, proposal: 'p16' },
  ],
  strict: [
    { op: 'decide-commit', activity: 'send_email', at: 1, args: { to: 'a' }, proposal: 'p1' },
    { op: 'grant', id: 'ap-1', activity: 'send_email', args: { to: 'a' }, proposal: 'p1', at: 2 },
    { op: 'decide-commit', activity: 'send_email', at: 2, args: { to: 'a' }, proposal: 'p1' },
    { op: 'decide-commit', activity: 'send_email', at: 3, args: { to: 'a' }, proposal: 'p2' },
    { op: 'decide-commit', activity: 'other_tool', at: 4, args: {}, proposal: 'p3' },
    { op: 'grant', id: 'ap-3', activity: 'other_tool', args: {}, proposal: 'p3', at: 5 },
    { op: 'decide-commit', activity: 'other_tool', at: 5, args: {}, proposal: 'p3' },
    { op: 'decide-commit', activity: 'llm', at: 6, args: {}, proposal: 'p4' },
    { op: 'decide-commit', activity: 'llm', at: 7, args: {}, proposal: 'p5' },
    { op: 'void', id: 'ap-3' },
  ],
};

const cases = [];
for (const [name, raw] of Object.entries(policies)) {
  const policy = admitPolicy(raw);
  const guard = createGuard(policy);
  let s = guard.init();
  const steps = [];
  for (const op of scripts[name]) {
    const out = { op };
    if (op.op === 'decide-commit') {
      const cls = classify(policy, op.activity);
      const c = { ...cls, target: op.activity, argsDigest: digest(op.args), at: op.at, proposal: op.proposal };
      const d = guard.decide(s, c);
      out.decision = { outcome: d.outcome, rules: d.rules, approval: d.approval ?? null };
      out.witnessDigest = d.witness ? digest(d.witness) : null;
      if (d.outcome === 'allow') s = guard.commit(s, c, d);
    } else if (op.op === 'observe') {
      const cls = classify(policy, op.activity);
      s = guard.observe(s, { kind: cls.kind, ok: op.ok, labels: cls.labels, result: op.result });
    } else if (op.op === 'grant') {
      const cls = classify(policy, op.activity);
      s = guard.grant(s, { id: op.id, kind: cls.kind, argsDigest: digest(op.args), proposal: op.proposal, at: op.at });
    } else if (op.op === 'signal') {
      s = guard.signal(s, op.name, op.at);
    } else if (op.op === 'void') {
      s = guard.voidApproval(s, op.id);
    }
    out.stateDigest = digest(s);
    steps.push(out);
  }
  cases.push({ name, policy: JSON.parse(JSON.stringify(policy)), steps });
}
writeFileSync(new URL('./guard.json', import.meta.url), `${JSON.stringify({ version: 1, cases }, null, 2)}\n`);

// Ledger: a fixed sequence, and every hash.
const run = { ns: 'acme', wf: 'wf/é-1', run: 'r-1' };
const l = openLedger({ run });
const appends = [
  ['admission', { level: 'guard', policy: { name: 'comms', version: 1, digest: 'sha256:00' } }, 1000],
  ['proposal', { source: 'workflow', action: 'slack_send', dataDigest: digest({ text: 'a' }) }, 1001],
  ['verdict', { proposal: 'p1', outcome: 'denied', rules: ['no-post-without-approval'], reason: 'x' }, 1001],
  ['observation', { effect: 'e3', ok: true, resultDigest: digest(1.5) }, 1002],
  ['closure', { outcome: 'completed' }, 1003],
];
for (const [kind, body, at] of appends) l.append(kind, body, at);
writeFileSync(new URL('./ledger.json', import.meta.url), `${JSON.stringify({ version: 1, run, appends, events: l.events() }, null, 2)}\n`);
console.log(`wrote ${cases.length} guard cases (${cases.reduce((a, c) => a + c.steps.length, 0)} steps) and ${l.events().length} ledger events`);
