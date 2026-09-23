// Version gating against the live fleet — FR-VER.1–.5; technical spec §5.6.
//
// polyvers decides whether a machine change is safe for a state; this module
// asks it once per DISTINCT live state and turns the answers into a decision
// per run:
//
//   auto-upgrade   every gate the change's lanes require passed, no migration
//   migrate        the gates passed over the MIGRATED state: move the run with it
//   pin            a gate failed for this state: the run finishes on the old version
//
// polyvers runs as its own process, through its own CLI, exactly as a person
// would run it: nothing here reimplements an engine, and its report is kept
// verbatim beside each decision. An empty fleet is refused unless the caller
// says so explicitly — "no runs in flight" and "we did not look" must not
// read the same (FR-VER.5).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { canonical, compareArtefacts } from '@cognitive-fab/polyflow-kernel';
import { CERTIFICATE_FILE, artefactDigests, checkMachineDir } from './certificates.mjs';

const require = createRequire(import.meta.url);
const polyversBin = () => join(dirname(require.resolve('@cognitive-fab/polygraph/package.json')), 'polyvers', 'bin', 'polyvers.mjs');

/** Run `polyvers check` over a one-state corpus. Returns the parsed report. */
function polyversCheck(oldDir, newDir, state) {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-vet-'));
  try {
    const corpus = join(dir, 'fleet.json');
    writeFileSync(corpus, JSON.stringify([state]));
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [polyversBin(), 'check', '--old', oldDir, '--new', newDir, '--snapshots', corpus, '--json'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // Exit 1 is a FAIL verdict with a report on stdout; anything else is a tool failure.
      if (err.status === 1 && err.stdout) stdout = err.stdout;
      else throw new Error(`polyvers could not run: ${err.stderr || err.message}`);
    }
    return JSON.parse(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {object} o
 * @param {string} o.oldDir  the version the runs are on
 * @param {string} o.newDir  the version about to ramp
 * @param {{workflowId:string, state:object}[]} o.fleet  live runs and their machine state
 * @param {boolean} [o.allowEmptyFleet]
 * @returns {{ ok, lanes, decisions, counts, reports }}
 */
/**
 * Is the new version one `polyflow admit` certified, file for file? polyvers
 * judges the CHANGE; it defers the effect checks (check-effects) to the
 * engine, and a PASS from it says nothing about whether the new version
 * would be admitted at all (P4/P5 review VG2). Returns a reason, or null.
 */
function admissionProblem(newDir, trust) {
  if (trust) {
    try { checkMachineDir(newDir, trust); return null; } catch (err) { return err.message; }
  }
  const certPath = join(newDir, CERTIFICATE_FILE);
  if (!existsSync(certPath)) return `${newDir}: no ${CERTIFICATE_FILE}; the new version was never admitted (run polyflow admit)`;
  const problems = compareArtefacts(JSON.parse(readFileSync(certPath, 'utf-8')), artefactDigests(newDir));
  return problems.length ? `${newDir}: the files are not the ones admitted (${problems.map((p) => `${p.name}: ${p.problem}`).join('; ')})` : null;
}

/** Effect kinds the new version's manifest can complete. */
function manifestKinds(dir) {
  const f = join(dir, 'effects.manifest.json');
  return existsSync(f) ? new Set(Object.keys(JSON.parse(readFileSync(f, 'utf-8')).effects ?? {})) : null;
}

export function vet({ oldDir, newDir, fleet, allowEmptyFleet = false, trust = null, allowUncertified = false }) {
  oldDir = resolve(oldDir);
  newDir = resolve(newDir);
  if (!allowUncertified) {
    const why = admissionProblem(newDir, trust);
    if (why) {
      // Still say what KIND of change it is: the operator reads both.
      const lanes = fleet?.length ? polyversCheck(oldDir, newDir, fleet[0].state).lanes ?? [] : [];
      return { ok: false, refused: `the new version is not admitted: ${why}`, decisions: [], lanes, counts: {}, reports: {} };
    }
  }
  const kinds = manifestKinds(newDir);
  if (!Array.isArray(fleet) || fleet.length === 0) {
    if (!allowEmptyFleet) {
      return { ok: false, refused: 'the fleet is empty: no live state was checked. Pass allowEmptyFleet if there really are no runs in flight.', decisions: [], lanes: [], counts: {}, reports: {} };
    }
  }
  const byState = new Map();
  const decisions = [];
  for (const run of fleet ?? []) {
    // An order the run has open must be one the new version can complete, or
    // the report that closes it would land on a machine that cannot hear it (VG2).
    const orphans = kinds ? (run.openKinds ?? []).filter((k) => !kinds.has(k)) : [];
    if (orphans.length) {
      decisions.push({ workflowId: run.workflowId, decision: 'pin', from: run.state, failed: [{ gate: 'open-orders', summary: `open order kinds unknown to the new version: ${orphans.join(', ')}` }] });
      continue;
    }
    const k = canonical(run.state);
    if (!byState.has(k)) byState.set(k, { state: run.state, runs: [] });
    byState.get(k).runs.push(run.workflowId);
  }
  const migratePath = join(newDir, 'migrate.cjs');
  const migrate = existsSync(migratePath) ? require(migratePath).migrate : null;
  const reports = {};
  let lanes = [];
  for (const [k, { state, runs }] of byState) {
    const report = polyversCheck(oldDir, newDir, state);
    reports[k] = report;
    lanes = report.lanes ?? lanes;
    const needsMigration = (report.lanes ?? []).some((l) => l === 'shape' || l === 'migration');
    let decision;
    let migrated;
    const failed = (report.gates ?? []).filter((g) => !g.ok).map((g) => ({ gate: g.gate, summary: g.summary, first: g.failures?.[0]?.message }));
    // A gate polyvers could not run is not a gate that passed. Admission (above)
    // covers the effect checks polyvers defers; anything else deferred pins.
    const deferred = (report.deferred ?? []).filter((g) => !/check-effects/.test(g.gate ?? g));
    for (const g of deferred) failed.push({ gate: g.gate ?? g, summary: `not run: ${g.reason ?? 'deferred'}` });
    if (report.verdict !== 'PASS' || deferred.length) decision = 'pin';
    else if (needsMigration) {
      decision = 'migrate';
      migrated = migrate(state);
    } else decision = 'auto-upgrade';
    for (const workflowId of runs) decisions.push({ workflowId, decision, from: state, ...(migrated ? { to: migrated } : {}), ...(failed.length ? { failed } : {}) });
  }
  const counts = decisions.reduce((a, d) => ({ ...a, [d.decision]: (a[d.decision] ?? 0) + 1 }), {});
  // The gate passes when no run has to be pinned: a pinned run keeps an old
  // worker alive, which is a decision a person makes, not a default.
  return { ok: !decisions.some((d) => d.decision === 'pin'), lanes, decisions, counts, reports };
}
