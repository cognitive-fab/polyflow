// Review P4/P5 — the version gate's vet step. No Temporal server.
// Fails today; see docs/platform/reviews/P4-P5-review.md, finding VG2.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vet } from '../src/vet.mjs';

const examples = fileURLToPath(new URL('../../../examples/', import.meta.url));
const V1 = join(examples, 'customer-brief');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// VG2 — a mapper-only change is polyvers' `composition` lane, whose only real
// gate (check-effects) polyvers DEFERS to polyrun and reports as NOT RUN. The
// verdict is still PASS, and vet turns PASS into auto-upgrade without looking
// at `report.deferred` or at whether the new version was ever admitted. Here
// the new mapper posts the brief the moment it enters review — no approval —
// which `polyflow admit` refuses. The gate passes it for every live run.
test('VG2: a new version that admission refuses does not pass the version gate', () => {
  const dir = mkdtempSync(join(examples, '.tmp-review-vet-'));
  made.push(dir);
  cpSync(V1, dir, { recursive: true });
  const f = join(dir, 'effects.cjs');
  const text = readFileSync(f, 'utf-8');
  const from = "out.push({ kind: 'request_approval', payload: { ticketCount: post.ticketCount } });";
  assert.ok(text.includes(from));
  writeFileSync(f, text.replace(from, "out.push({ kind: 'post_brief', payload: { ticketCount: post.ticketCount } });"));
  const r = vet({
    oldDir: V1, newDir: dir,
    fleet: [
      { workflowId: 'polyflow/customer-brief/a', state: { briefState: 'idle', ticketCount: 0, reason: '' } },
      { workflowId: 'polyflow/customer-brief/b', state: { briefState: 'drafting', ticketCount: 3, reason: '' } },
    ],
  });
  assert.deepEqual(r.lanes, ['composition']);
  assert.equal(r.ok, false, `the gate passed a version that posts without approval: ${JSON.stringify(r.decisions.map((d) => d.decision))}`);
});
