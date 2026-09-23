// P4.1 — `polyflow admit`: FR-ADM.1–.5.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateSigningKey, checkMachineDir, verifyCertificate, CERTIFICATE_FILE } from '@cognitive-fab/polyflow-temporal';
import { main } from '../src/main.mjs';

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const UNSAFE = fileURLToPath(new URL('../../../../test/fixtures/unsafe-brief/', import.meta.url));

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A private copy of a machine directory, under the platform tree so its require('@cognitive-fab/sam-pattern') resolves. */
function copy(src) {
  const dir = mkdtempSync(join(fileURLToPath(new URL('../../../examples/', import.meta.url)), '.tmp-admit-'));
  cpSync(src, dir, { recursive: true });
  made.push(dir);
  return dir;
}

const run = async (argv) => { const lines = []; const code = await main(argv, (x) => lines.push(x)); return { code, text: lines.join('\n') }; };

function keyFile() {
  const key = generateSigningKey('ci');
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-key-'));
  writeFileSync(join(dir, 'ci.key.json'), JSON.stringify(key));
  return { key, file: join(dir, 'ci.key.json'), trust: { ci: key.publicKeyPem } };
}

test('a safe machine is admitted, and the certificate names every file it checked', async () => {
  const dir = copy(BRIEF);
  const k = keyFile();
  const r = await run(['admit', dir, '--key', k.file]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /ADMITTED customer-brief as cert-[0-9a-f]{12} \(signed by ci\)/);
  assert.match(r.text, /guarantees: at-most-one-post-per-path, no-post-without-prior-approval/);
  const cert = JSON.parse(readFileSync(join(dir, CERTIFICATE_FILE), 'utf-8'));
  assert.deepEqual(Object.keys(cert.artefacts).sort(), ['contract', 'descriptor', 'effectInvariants', 'effects', 'invariants', 'machine', 'manifest']);
  assert.equal(verifyCertificate(cert, k.trust).ok, true);
  assert.equal(checkMachineDir(dir, k.trust).buildId, cert.buildId);
});

test('an unsafe machine is refused, with the violated rule, and nothing is certified', async () => {
  const dir = copy(UNSAFE);
  const r = await run(['admit', dir]);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /no-post-without-prior-approval/);
  assert.match(r.text, /REFUSED/);
  assert.equal(existsSync(join(dir, CERTIFICATE_FILE)), false);
});

test('one edited line after admission and the worker-side check refuses, naming the file', async () => {
  const dir = copy(BRIEF);
  const k = keyFile();
  assert.equal((await run(['admit', dir, '--key', k.file])).code, 0);
  const machine = join(dir, 'machine.cjs');
  writeFileSync(machine, readFileSync(machine, 'utf-8').replace("return reject('already-started');", "return reject('already-started!');"));
  assert.throws(() => checkMachineDir(dir, k.trust), (err) => /machine .*machine\.cjs.*: changed since certification/s.test(err.message));
});

test('an unsigned or untrusted certificate is refused by the worker-side check', async () => {
  const dir = copy(BRIEF);
  assert.equal((await run(['admit', dir])).code, 0);
  assert.throws(() => checkMachineDir(dir, {}), /the certificate is unsigned/);
  const k = keyFile();
  assert.equal((await run(['admit', dir, '--key', k.file])).code, 0);
  assert.throws(() => checkMachineDir(dir, { ci: generateSigningKey('ci').publicKeyPem }), /no signature from a trusted key verifies/);
});

test('a waiting-on-a-person step that arms no timer is refused as structural', async () => {
  const dir = copy(BRIEF);
  const effects = join(dir, 'effects.cjs');
  writeFileSync(effects, readFileSync(effects, 'utf-8').replace(/\s*out\.push\(\{ kind: 'timer'[^\n]*\n/, '\n'));
  const r = await run(['admit', dir]);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /waits-on-people-arm-timers/);
});

test('a state that waits for a message nobody sends is refused as stranded (P4/P5 review WT)', async () => {
  // Rewire the draft order's completions to an action the drafting state rejects:
  // every-state-can-finish still passes (DRAFT_READY is in the domain), but
  // nothing that can actually happen moves the run out of drafting.
  const dir = copy(BRIEF);
  const f = join(dir, 'effects.manifest.json');
  const m = JSON.parse(readFileSync(f, 'utf-8'));
  m.effects.draft_brief.onSuccess = { action: 'POST_DONE' };
  m.effects.draft_brief.onFailure = { action: 'POST_DONE' };
  delete m.effects.draft_brief.onExhausted;
  writeFileSync(f, JSON.stringify(m, null, 2));
  const r = await run(['admit', dir]);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /every-wait-has-an-exit/);
  assert.match(r.text, /drafting/);
});

test('an edited certificate is detected even when every file still matches', async () => {
  const dir = copy(BRIEF);
  const k = keyFile();
  await run(['admit', dir, '--key', k.file]);
  const p = join(dir, CERTIFICATE_FILE);
  const cert = JSON.parse(readFileSync(p, 'utf-8'));
  cert.guarantees.push('a-guarantee-nobody-checked');
  writeFileSync(p, JSON.stringify(cert));
  assert.throws(() => checkMachineDir(dir, k.trust), /edited after sealing/);
});

const TRIAGE = fileURLToPath(new URL('../../../examples/refund-triage/', import.meta.url));

test('refund-triage is admitted, with its unstoppable state named in the certificate', async () => {
  const dir = copy(TRIAGE);
  const r = await run(['admit', dir, '--json']);
  assert.equal(r.code, 0, r.text);
  const out = JSON.parse(r.text);
  const stop = out.checks.find((c) => c.name === 'structural').items.find((i) => i.name === 'stop-from-every-state');
  assert.deepEqual(Object.keys(stop.exceptions), ['refunding']);
  assert.ok(out.certificate.artefacts.observations, 'the judge\'s battery is a certified artefact');
});

test('a machine that treats the judge\'s abstention as a yes is refused before it can run', async () => {
  const dir = copy(TRIAGE);
  const m = join(dir, 'machine.cjs');
  // The tempting bug: "not refuted" read as "asserted".
  writeFileSync(m, readFileSync(m, 'utf-8').replace('const clear = proposal.reasonStated === true && proposal.fraud === false;', 'const clear = proposal.reasonStated !== false && proposal.fraud !== true;'));
  const r = await run(['admit', dir]);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /no-refund-unless-the-judge-cleared-it-or-a-person-approved/);
});
