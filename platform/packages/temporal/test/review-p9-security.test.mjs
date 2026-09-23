// P9 security review — the Node side of the Temporal plugin, no server needed.
// Each test asserts a security property and fails today for the reason in its
// message. See docs/platform/reviews/P9-security-review.md (ids in the titles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { defaultPayloadConverter } from '@temporalio/common';
import { openLedger, buildCertificate, sealCertificate } from '@cognitive-fab/polyflow-kernel';
import {
  exporter, memorySink, generateSigningKey, PolyflowPlugin, runPaths, LEDGER_HEADER,
  artefactDigests, signCertificate, checkMachineDir, CERTIFICATE_FILE,
} from '../src/index.mjs';

const key = generateSigningKey('deployment');

/** A self-consistent chain for `run`, as any workflow code could build it with the public kernel. */
function forgedDelta(run) {
  const l = openLedger({ run });
  l.append('admission', { level: 'guard', policy: { name: 'comms', version: 1, digest: 'sha256:00' } }, 1000);
  l.append('proposal', { source: 'human', principal: { id: 'cfo', verified: true }, action: 'approve', approvalId: 'ap-p1' }, 1001);
  l.append('closure', { outcome: 'completed' }, 1002);
  return l.drain();
}

/** Run the activity-side exporter once, as the worker would for one activity task. */
async function deliver(ex, headerValue, info) {
  const input = { args: [], headers: { [LEDGER_HEADER]: defaultPayloadConverter.toPayload(headerValue) } };
  await ex({ info }).inbound.execute(input, async () => 'activity ran');
}

const activityOf = (workflowId, runId) => ({ workflowNamespace: 'default', workflowExecution: { workflowId, runId } });

test('SEC-EX1: the exporter does not sign a chain that starts at seq 0 for a run other than the activity\'s own', async () => {
  const sink = memorySink();
  const errors = [];
  const ex = exporter({ sink, signingKey: key, onError: (e) => errors.push(e.message) });
  // Any workflow able to put an activity on this worker's task queue with this
  // workflow id (a workflow on another worker, a re-used id after the victim
  // closed) names a run id of its choosing.
  const victim = { ns: 'default', wf: 'payments/2026-09-22', run: 'run-that-never-happened' };
  const events = forgedDelta(victim);
  await deliver(ex, { events, head: { seq: 2, hash: events[2].hash } }, activityOf('payments/2026-09-22', 'the-real-run-id'));
  const { heads } = sink.read(victim);
  assert.equal(heads.length, 0, `SEC-EX1: the deployment key signed seq ${heads[0]?.seq} of run '${victim.run}' (a CFO approval and a closure nobody recorded) for an activity of run 'the-real-run-id'. A delta that starts a chain (seq 0) must name the activity's own run id`);
});

test('SEC-EX2: with sealed headers configured, the exporter refuses a plaintext ledger header instead of signing it', async () => {
  const headerKey = { keyId: 'hk1', key: randomBytes(32).toString('base64') };
  const sink = memorySink();
  const ex = exporter({ sink, signingKey: key, headerKeys: { [headerKey.keyId]: headerKey.key }, onError: () => {} });
  // A workflow that does not hold the data key (one on a worker without the
  // plugin's configuration) cannot seal; it can still send plaintext.
  const run = { ns: 'default', wf: 'wf-downgrade', run: 'r-1' };
  const events = forgedDelta(run);
  await deliver(ex, { events, head: { seq: 2, hash: events[2].hash } }, activityOf('wf-downgrade', 'r-1'));
  assert.equal(sink.read(run).heads.length, 0, 'SEC-EX2: a plaintext header was accepted and SIGNED by a worker configured with headerKey: the seal is optional, so it authenticates nothing');
});

test('SEC-KY1: the header data key is not written in clear to the generated interceptor module on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p9-gen-'));
  try {
    const headerKey = { keyId: 'hk1', key: randomBytes(32).toString('base64') };
    const plugin = new PolyflowPlugin({ headerKey, generatedDir: dir });
    const file = plugin.interceptorModule();
    const text = readFileSync(file, 'utf-8');
    assert.ok(!text.includes(headerKey.key), `SEC-KY1: ${file} holds the ChaCha20 data key in clear (and so does every workflow bundle built from it); by default this lands under os.tmpdir() with default permissions`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SEC-FS1: the file sink keeps every run inside its root and never gives two runs the same file', () => {
  const root = resolve(mkdtempSync(join(tmpdir(), 'p9-sink-')));
  try {
    const escaped = runPaths(root, { ns: '..', wf: '..', run: 'r' }).events;
    assert.ok(resolve(escaped).startsWith(root + sep), `SEC-FS1: namespace '..' and workflow id '..' write ${escaped}, outside the sink root ${root}`);
    const a = runPaths(root, { ns: 'default', wf: 'x%', run: 'r' }).events;
    const b = runPaths(root, { ns: 'default', wf: 'x~25', run: 'r' }).events;
    assert.notEqual(a, b, `SEC-FS1: workflow ids 'x%' and 'x~25' share ${a}: one run's events pre-empt the other's seqs, and the victim's real deltas are refused as conflicts`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEC-CT1: a machine module required through a template literal is covered by the certificate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p9-cert-'));
  try {
    writeFileSync(join(dir, 'polyflow.workflow.json'), JSON.stringify({ name: 'm' }));
    writeFileSync(join(dir, 'contract.json'), '{}');
    // webpack bundles `require(\`./x\`)` exactly like require('./x').
    writeFileSync(join(dir, 'machine.cjs'), "const rules = require(`./rules.cjs`);\nmodule.exports = { rules };\n");
    writeFileSync(join(dir, 'rules.cjs'), 'module.exports = { maxRefund: 100 };\n');
    const body = buildCertificate({ machine: 'm', artefacts: artefactDigests(dir), guarantees: ['refund-cap'], checks: [], domains: {}, toolchain: {}, issuedAt: 0 });
    writeFileSync(join(dir, CERTIFICATE_FILE), JSON.stringify(signCertificate(sealCertificate(body), key)));
    const trust = { [key.keyId]: key.publicKeyPem };
    checkMachineDir(dir, trust); // baseline: certified as written
    writeFileSync(join(dir, 'rules.cjs'), 'module.exports = { maxRefund: 1e9 };\n'); // after admission
    assert.throws(() => checkMachineDir(dir, trust), /not the ones admitted/, 'SEC-CT1: rules.cjs changed after admission and the worker would still run it: the certificate walks only require(\'./..\') string literals (not template literals, concatenations, import(), or package requires)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
