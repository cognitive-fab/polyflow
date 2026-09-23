// Review P4/P5 — admission and the worker-side certificate check.
// Each test asserts what the spec claims; each FAILS today. See
// docs/platform/reviews/P4-P5-review.md for the finding it belongs to.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSigningKey, checkMachineDir, PolyflowPlugin, loadMachineDir } from '@cognitive-fab/polyflow-temporal';
import { admit } from '../src/admit.mjs';

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A private copy under examples/, so require('@cognitive-fab/sam-pattern') resolves. */
function copy(src) {
  const dir = mkdtempSync(join(fileURLToPath(new URL('../../../examples/', import.meta.url)), '.tmp-review-p4p5-'));
  cpSync(src, dir, { recursive: true });
  made.push(dir);
  return dir;
}
const edit = (file, from, to) => {
  const text = readFileSync(file, 'utf-8');
  assert.ok(text.includes(from), `fixture edit: '${from}' not found in ${file}`);
  writeFileSync(file, text.replace(from, to));
};
const ciKey = () => { const key = generateSigningKey('ci'); return { key, trust: { ci: key.publicKeyPem } }; };

// AB1 — FR-ADM.2: "a check that hits its ceiling refuses admission UNLESS the
// owner accepts the bound explicitly, and the acceptance is recorded". admit()
// marks the bounded check ok:false, and buildCertificate refuses any ok:false
// check, so --accept-bound never certifies: it throws instead.
test('AB1: a bound the owner accepts is certified, with the acceptance recorded', async () => {
  const dir = copy(BRIEF);
  const r = await admit(dir, { acceptBound: 'the owner accepts depth 2 for this test', maxDepth: 2 });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.certificate.boundAccepted, 'the owner accepts depth 2 for this test');
});

// IN1 — FR-ADM.1 lists invariants among the artefacts admission checks; the
// certificate digests invariants.mjs but no check ever evaluates it. A state
// invariant that every reachable state violates is certified.
test('IN1: a state invariant the machine violates is not certified', async () => {
  const dir = copy(BRIEF);
  edit(join(dir, 'invariants.mjs'), 'export const stateInvariants = [', `export const stateInvariants = [
  { name: 'never-leaves-idle', pred: (s) => s.briefState === 'idle' },`);
  const r = await admit(dir);
  assert.equal(r.ok, false, 'a violated state invariant was admitted: invariants.mjs is digested, never checked');
});

// DEP1 — FR-ADM.3: "the plugin will not load a machine whose artefacts do not
// match a valid certificate". Only the nine named files are digested. A module
// the machine requires is bundled into the worker but is not an artefact, so
// it can change after admission and the worker-side check still passes.
test('DEP1: editing a module the machine requires, after admission, is refused by the worker-side check', async () => {
  const dir = copy(BRIEF);
  writeFileSync(join(dir, 'rules.cjs'), "module.exports.approvedState = 'posting';\n");
  edit(join(dir, 'machine.cjs'), "const { createInstance } = require('@cognitive-fab/sam-pattern');",
    "const { createInstance } = require('@cognitive-fab/sam-pattern');\nconst rules = require('./rules.cjs');");
  edit(join(dir, 'machine.cjs'), "next.briefState = 'posting';", 'next.briefState = rules.approvedState;');
  const { key, trust } = ciKey();
  const r = await admit(dir, { key });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  // After admission: APPROVED now jumps straight to 'posted' — nothing is posted, the run reports success.
  writeFileSync(join(dir, 'rules.cjs'), "module.exports.approvedState = 'posted';\n");
  assert.throws(() => checkMachineDir(dir, trust), /rules\.cjs/, 'the edited dependency passed the certificate check');
});

// PL1 — the certificate covers policy.json, but the worker's guard enforces
// whatever `policy` the plugin was constructed with (or none: level
// 'observe'). Nothing ties the two together.
test('PL1: a worker refuses to run a certified machine without the policy its certificate names', async () => {
  const dir = copy(BRIEF);
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({
    policy: 'brief', version: 1,
    effects: {
      fetch_tickets: { kind: 'fetch', class: 'none' },
      draft_brief: { kind: 'draft', class: 'none' },
      request_approval: { kind: 'approval', class: 'none' },
      post_brief: { kind: 'post', class: 'irreversible', labels: ['egress'] },
    },
    rules: [
      { id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' },
      { id: 'at-most-one-post', type: 'at-most', guards: 'post', n: 1 },
    ],
  }));
  const { key, trust } = ciKey();
  const r = await admit(dir, { key });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(r.certificate.artefacts.policy, 'the certificate names the policy');
  assert.throws(
    () => new PolyflowPlugin({ level: 'observe', machines: { 'customer-brief': dir }, trust }),
    /policy/,
    'the plugin accepted a certified machine and enforces no policy at all',
  );
});

// BV1 — FR-ADM.6 / tech spec §7.2: "checks buildId equals the worker's
// deployment build id when Worker Versioning is on ... any mismatch fails
// Worker.create". plugin.buildId() exists but nothing consults it.
test('BV1: a worker whose deployment build id is not the certificate refuses to start', async () => {
  const dir = copy(BRIEF);
  const { key, trust } = ciKey();
  assert.equal((await admit(dir, { key })).ok, true);
  const plugin = new PolyflowPlugin({ machines: { 'customer-brief': dir }, trust });
  assert.match(plugin.buildId(), /^cert-/);
  assert.throws(() => plugin.configureWorker({
    taskQueue: 'q', workflowsPath: 'unused',
    workerDeploymentOptions: { useWorkerVersioning: true, version: { deploymentName: 'brief', buildId: 'some-other-build' }, defaultVersioningBehavior: 'PINNED' },
  }), /build/i, 'the worker would run under a build id that is not its certificate');
});

// SA1 — loadMachineDir builds the descriptor the workflow sees from a fixed
// list of fields and drops `stopAction` and `claimLeaseMs`. The workflow's STOP
// handling (quarantine exit) and lease length read exactly those fields, so a
// declared STOP never works on Temporal and every lease is the 10-minute default.
test('SA1: the descriptor the workflow receives keeps stopAction and claimLeaseMs', () => {
  const dir = copy(BRIEF);
  const d = JSON.parse(readFileSync(join(dir, 'polyflow.workflow.json'), 'utf-8'));
  writeFileSync(join(dir, 'polyflow.workflow.json'), JSON.stringify({ ...d, stopAction: 'DENIED', claimLeaseMs: 5000 }));
  const { descriptor } = loadMachineDir(dir);
  assert.equal(descriptor.stopAction, 'DENIED');
  assert.equal(descriptor.claimLeaseMs, 5000);
});

