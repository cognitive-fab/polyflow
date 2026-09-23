// P4.3 — vetting a version change against the live fleet (FR-VER.1–.5).
// No Temporal server: polyvers runs as its own process over fleet snapshots.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vet } from '../src/vet.mjs';
import { admit } from '@cognitive-fab/polyflow-cli/src/admit.mjs';

const examples = fileURLToPath(new URL('../../../examples/', import.meta.url));
const V1 = join(examples, 'customer-brief');
const V2 = join(examples, 'customer-brief-v2'); // adds CANCEL: widens the state enum, so it needs migrate.cjs

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A copy of a version directory, changed by `edit`, and admitted: the gate vets admitted versions only (review VG2). */
async function admitted(src, edit = () => {}) {
  const dir = mkdtempSync(join(examples, '.tmp-vet-'));
  made.push(dir);
  cpSync(src, dir, { recursive: true });
  edit(dir);
  const r = await admit(dir);
  assert.ok(r.ok, `admission: ${JSON.stringify(r.problems)}`);
  return dir;
}

const review = { briefState: 'review', ticketCount: 3, reason: '' };
const idle = { briefState: 'idle', ticketCount: 0, reason: '' };

test('a shape change migrates every run whose state passes the gates, and pins the one that does not', async () => {
  const V2a = await admitted(V2);
  const legacy = { briefState: 'denied', ticketCount: 0, reason: '' }; // written by an old bug: violates a v2 invariant
  const r = vet({
    oldDir: V1, newDir: V2a,
    fleet: [
      { workflowId: 'polyflow/customer-brief/a', state: idle },
      { workflowId: 'polyflow/customer-brief/b', state: review },
      { workflowId: 'polyflow/customer-brief/c', state: review },
      { workflowId: 'polyflow/customer-brief/d', state: legacy },
    ],
  });
  assert.ok(r.lanes.includes('shape') && r.lanes.includes('vocabulary'));
  const by = Object.fromEntries(r.decisions.map((d) => [d.workflowId.slice(-1), d]));
  assert.equal(by.a.decision, 'migrate');
  assert.equal(by.b.decision, 'migrate');
  assert.deepEqual(by.b.to, review);
  assert.equal(by.d.decision, 'pin');
  assert.ok(by.d.failed.some((f) => /invariants-pointwise/.test(f.gate)));
  assert.equal(r.ok, false, 'a pinned run keeps an old worker alive: the gate does not pass by default');
  assert.equal(Object.keys(r.reports).length, 3, 'polyvers ran once per DISTINCT state, not per run');
});

test('a change that needs no migration auto-upgrades the runs it is safe for', async () => {
  const dir = await admitted(V1, (d) => {
    const m = join(d, 'machine.cjs');
    writeFileSync(m, `${readFileSync(m, 'utf-8')}\n// v1.1: a comment-level change — the module changed, the rules did not.\n`);
  });
  const r = vet({ oldDir: V1, newDir: dir, fleet: [{ workflowId: 'w1', state: idle }, { workflowId: 'w2', state: review }] });
  assert.equal(r.ok, true, r.refused ?? JSON.stringify(r.decisions));
  assert.deepEqual(r.decisions.map((d) => d.decision), ['auto-upgrade', 'auto-upgrade']);
});

test('an empty fleet is refused unless the caller says there really are no runs', async () => {
  const V2a = await admitted(V2);
  const r = vet({ oldDir: V1, newDir: V2a, fleet: [] });
  assert.equal(r.ok, false);
  assert.match(r.refused, /the fleet is empty/);
  assert.equal(vet({ oldDir: V1, newDir: V2a, fleet: [], allowEmptyFleet: true }).ok, true);
});

test('an unadmitted new version, or one changed after admission, does not pass the gate (review VG2)', async () => {
  const fleet = [{ workflowId: 'w1', state: idle }];
  assert.match(vet({ oldDir: V1, newDir: V2, fleet }).refused, /never admitted/);
  const V2a = await admitted(V2);
  const m = join(V2a, 'machine.cjs');
  writeFileSync(m, `${readFileSync(m, 'utf-8')}
// changed after admission
`);
  assert.match(vet({ oldDir: V1, newDir: V2a, fleet }).refused, /not the ones admitted/);
});

test('a run with an open order the new version cannot complete is pinned (review VG2)', async () => {
  const dir = await admitted(V1, (d) => {
    const m = join(d, 'machine.cjs');
    writeFileSync(m, `${readFileSync(m, 'utf-8')}
// v1.1
`);
  });
  const r = vet({ oldDir: V1, newDir: dir, fleet: [{ workflowId: 'w1', state: review, openKinds: ['legacy_kind'] }, { workflowId: 'w2', state: review, openKinds: ['request_approval'] }] });
  assert.deepEqual(r.decisions.map((d) => d.decision), ['pin', 'auto-upgrade']);
  assert.equal(r.decisions[0].failed[0].gate, 'open-orders');
});
