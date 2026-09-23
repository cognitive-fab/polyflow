// Generates the conformance vectors for the P9 security review's kernel changes,
// computed by the TypeScript kernel (docs/platform/reviews/P9-security-review.md):
//
// - sealed.json (SEC-SH1/SH2): sealHeader outputs, which are deterministic
//   (synthetic IV), and openHeader refusals. Every other implementation must
//   produce the same envelope, byte for byte, and refuse the same inputs.
// - routed-guard.json (SEC-UL1): a routed call whose tool the policy does not
//   declare is DENIED, whatever `unlabelled` says. Same case format as guard.json.
import { writeFileSync } from 'node:fs';
import { admitPolicy, createGuard, classify, digest, sealHeader, openHeader, openLedger } from '../packages/kernel/src/index.mjs';

// ---- sealed headers ----------------------------------------------------------------

const keyA = { keyId: 'k-2026', key: Buffer.alloc(32, 7).toString('base64') };
const keyB = { keyId: 'k-other', key: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1)).toString('base64') };
const ledger = openLedger({ run: { ns: 'default', wf: 'wf-1', run: 'r-1' } });
ledger.append('admission', { level: 'guard', policy: null }, 1000);
ledger.append('proposal', { source: 'workflow', action: 'slack_send', dataDigest: digest({ text: 'a' }) }, 1001);

const sealCases = [
  ['a ledger delta', { events: ledger.events(), head: ledger.head() }, keyA, { runId: 'r-1', purpose: 'ledger', seq: 1 }],
  ['the same seq, a different body (SEC-SH1: a different nonce)', { events: ledger.events().slice(0, 1), head: ledger.head() }, keyA, { runId: 'r-1', purpose: 'ledger', seq: 1 }],
  ['the same body, another run (SEC-SH2)', { events: ledger.events(), head: ledger.head() }, keyA, { runId: 'r-2', purpose: 'ledger', seq: 1 }],
  ['a Continue-as-New head with guard state', { run: { ns: 'default', wf: 'wf-1', run: 'r-1' }, seq: 9, hash: 'sha256:ab', guard: { seq: 2, meters: { usd: 1.5 }, trace: [] } }, keyA, { runId: 'r-1', purpose: 'head', seq: 9 }],
  ['another key', { a: 1 }, keyB, { runId: 'r-1', purpose: 'ledger', seq: 0 }],
  ['unicode and key order', { z: 'é\u{1F4E6}', a: [1, 2.5, null, true], m: { b: 1, a: 2 } }, keyB, { runId: 'r/é', purpose: 'ledger', seq: 12 }],
  ['empty object', {}, keyA, { runId: 'r-1', purpose: 'ledger', seq: 3 }],
];
const seal = sealCases.map(([name, value, headerKey, at]) => ({ name, value, headerKey, at, sealed: sealHeader(value, headerKey, at) }));

const keys = { [keyA.keyId]: keyA.key, [keyB.keyId]: keyB.key };
const s0 = seal[0].sealed;
const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
const openCases = [
  ['opens', s0, keys, {}],
  ['plaintext passes when not required', { events: [] }, keys, {}],
  ['plaintext refused when required', { events: [] }, keys, { required: true }],
  ['unknown key', s0, { [keyB.keyId]: keyB.key }, {}],
  ['tampered ciphertext', { ...s0, ct: flip(s0.ct) }, keys, {}],
  ['tampered nonce', { ...s0, nonce: flip(s0.nonce) }, keys, {}],
  ['transplanted to another run (the AAD binds it)', { ...s0, runId: 'r-2' }, keys, {}],
  ['transplanted to another seq', { ...s0, seq: 2 }, keys, {}],
  ['relabelled purpose', { ...s0, purpose: 'head' }, keys, {}],
  ['expected run differs', s0, keys, { expect: { runId: 'r-9' } }],
  ['expected purpose differs', s0, keys, { expect: { purpose: 'head' } }],
  ['expected context matches', s0, keys, { required: true, expect: { runId: 'r-1', purpose: 'ledger' } }],
];
const open = openCases.map(([name, value, k, options]) => {
  try {
    return { name, value, keys: k, options, opened: openHeader(value, k, options) };
  } catch (err) {
    return { name, value, keys: k, options, refused: true };
  }
});

writeFileSync(new URL('./sealed.json', import.meta.url), `${JSON.stringify({
  version: 2,
  rule: 'sealHeader: nonce = HMAC-SHA256(HMAC-SHA256(key, "polyflow-header-nonce-key"), context + "\\n" + canonical(value))[0:12]; AAD = context = polyflow/<purpose>|<keyId>|<runId>|<seq>; ChaCha20-Poly1305',
  seal, open,
}, null, 2)}\n`);

// ---- routed calls are denied whatever `unlabelled` says ----------------------------

const MCP = 'Tickets-stateless-call-tool-v2';
const base = {
  version: 1,
  effects: {
    [`${MCP}:read_ticket`]: { kind: 'read', class: 'none' },
    [`${MCP}:issue_refund`]: { kind: 'refund', class: 'irreversible' },
  },
  routes: { [MCP]: '0.tool_name' },
  rules: [{ id: 'one-refund', type: 'at-most', guards: 'refund', n: 1 }],
};
const policies = {
  'routed-report': { ...base, policy: 'routed-report', unlabelled: 'report' },
  'routed-escalate': { ...base, policy: 'routed-escalate', unlabelled: 'escalate', escalation: { role: 'approver', timeoutMs: 1000 } },
  'routed-budget': { ...base, policy: 'routed-budget', unlabelled: 'report', rules: [...base.rules, { id: 'calls', type: 'budget', metric: 'effects', max: 2 }] },
};
const script = [
  { op: 'decide-commit', activity: `${MCP}:read_ticket`, at: 1, args: [{ tool_name: 'read_ticket' }], proposal: 'p1' },
  { op: 'observe', activity: `${MCP}:read_ticket`, ok: true },
  { op: 'decide-commit', activity: `${MCP}:issue_REFUND`, at: 2, args: [{ tool_name: 'issue_REFUND' }], proposal: 'p2' },
  { op: 'decide-commit', activity: `${MCP}: issue_refund`, at: 3, args: [{ tool_name: ' issue_refund' }], proposal: 'p3' },
  { op: 'decide-commit', activity: `${MCP}:?`, at: 4, args: [{}], proposal: 'p4' },
  { op: 'grant', id: 'ap-p5', activity: `${MCP}:delete_all`, args: [{ tool_name: 'delete_all' }], proposal: 'p5', at: 5 },
  { op: 'decide-commit', activity: `${MCP}:delete_all`, at: 5, args: [{ tool_name: 'delete_all' }], proposal: 'p5' },
  { op: 'decide-commit', activity: 'plain_unlabelled_tool', at: 6, args: [], proposal: 'p6' },
  { op: 'decide-commit', activity: 'Other-call-tool:x', at: 7, args: [], proposal: 'p7' },
  { op: 'decide-commit', activity: `${MCP}:issue_refund`, at: 8, args: [{ tool_name: 'issue_refund' }], proposal: 'p8' },
  { op: 'decide-commit', activity: `${MCP}:issue_refund`, at: 9, args: [{ tool_name: 'issue_refund' }], proposal: 'p9' },
];
const cases = [];
for (const [name, raw] of Object.entries(policies)) {
  const policy = admitPolicy(raw);
  const guard = createGuard(policy);
  let s = guard.init();
  const steps = [];
  for (const op of script) {
    const out = { op };
    if (op.op === 'decide-commit') {
      const cls = classify(policy, op.activity);
      const c = { ...cls, target: op.activity, argsDigest: digest(op.args), at: op.at, proposal: op.proposal };
      const d = guard.decide(s, c);
      out.classification = cls;
      out.decision = { outcome: d.outcome, rules: d.rules, approval: d.approval ?? null };
      out.witnessDigest = d.witness ? digest(d.witness) : null;
      if (d.outcome === 'allow') s = guard.commit(s, c, d);
    } else if (op.op === 'observe') {
      const cls = classify(policy, op.activity);
      s = guard.observe(s, { kind: cls.kind, ok: op.ok, labels: cls.labels, result: op.result });
    } else if (op.op === 'grant') {
      const cls = classify(policy, op.activity);
      s = guard.grant(s, { id: op.id, kind: cls.kind, argsDigest: digest(op.args), proposal: op.proposal, at: op.at });
    }
    out.stateDigest = digest(s);
    steps.push(out);
  }
  cases.push({ name, policy: JSON.parse(JSON.stringify(policy)), steps });
}
writeFileSync(new URL('./routed-guard.json', import.meta.url), `${JSON.stringify({ version: 1, cases }, null, 2)}\n`);
console.log(`wrote ${seal.length} seal and ${open.length} open vectors, and ${cases.length} routed guard cases`);

// ---- file-sink paths (SEC-FS1/PY2): one encoding in both languages ------------------

const { runPaths } = await import('../packages/temporal/src/sink.mjs');
const { relative, sep } = await import('node:path');
const pathRuns = [
  { ns: 'default', wf: 'wf-1_A', run: 'r-1' },
  { ns: '..', wf: '..', run: 'r' },
  { ns: '.', wf: 'x%', run: 'x~25' },
  { ns: `a/b${String.fromCharCode(92)}c`, wf: 'wf/é-1', run: '' },
  { ns: 'default', wf: `lone${String.fromCharCode(0xd800)}`, run: '\u{1F4E6}' },
];
const sinkPaths = pathRuns.map((run) => {
  const p = runPaths('ROOT', run);
  return { run, parts: relative('ROOT', p.events).split(sep) };
});
writeFileSync(new URL('./sink-paths.json', import.meta.url), `${JSON.stringify({ version: 1, rule: 'each UTF-8 byte kept if [A-Za-z0-9_-], else ~ + two upper-case hex digits; an empty component is ~', cases: sinkPaths }, null, 2)}\n`);
console.log(`wrote ${sinkPaths.length} sink path cases`);
