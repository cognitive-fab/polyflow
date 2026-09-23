// PolyflowGateWorkflow — the version gate a Temporal Worker Controller runs
// before it promotes a new worker deployment version (FR-VER.1–.6; technical
// spec §5.6). Runs INSIDE the workflow isolate; everything with I/O is an
// activity (gate-activities.mjs).
//
//   fleet   the machine state of every running governed run of this machine
//   vet     polyvers over each distinct live state -> a decision per run
//   apply   migrate: an Update carrying the migrated state; auto-upgrade and
//           pin: recorded on the run itself
//
// The gate FAILS — and the controller does not promote — when any run would
// have to be pinned, or when the fleet is empty and nobody said that is
// expected. The failure carries the decisions, so the operator sees which
// runs, which gate, and why.

import { proxyActivities, ApplicationFailure } from '@temporalio/workflow';

const acts = proxyActivities({ startToCloseTimeout: '10 minutes', retry: { maximumAttempts: 3 } });

/**
 * @param {object} input
 * @param {string} input.machine
 * @param {string} input.oldDir   artefact directory of the version in flight
 * @param {string} input.newDir   artefact directory of the version about to ramp
 * @param {string} [input.toBuildId]
 * @param {boolean} [input.allowEmptyFleet]
 * @param {boolean} [input.apply]  default true
 */
/**
 * The policy ramp gate (P4.6). Fails, listing the runs that would lose an
 * effect they are allowed now, unless every run may move to the new policy.
 */
export async function PolyflowPolicyGateWorkflow({ oldPolicy, newPolicy, query = null, allowEmptyFleet = false } = {}) {
  const r = await acts['polyflow.gate.policy']({ oldPolicy, newPolicy, query, allowEmptyFleet });
  if (!r.ok) {
    throw ApplicationFailure.create({
      type: 'PolyflowGateRefused', nonRetryable: true, details: [r],
      message: r.refused ? `policy ramp refused: ${r.refused}` : `${r.counts.pin} run(s) would lose an effect they are allowed now: ${r.decisions.filter((d) => d.decision === 'pin').map((d) => `${d.workflowId} (${d.revoked.join(', ')})`).join('; ')}`,
    });
  }
  return r;
}

export async function PolyflowGateWorkflow({ machine, oldDir, newDir, toBuildId = null, fromBuildId = null, allowEmptyFleet = false, apply = true, onVersionChange = false, phase = 'vet' } = {}) {
  // Phase 'wake' runs after the controller promoted the new version: the runs
  // told to move are woken so each continues as new onto it (P4/P5 review VG1).
  if (phase === 'wake') return { machine, phase, ...(await acts['polyflow.gate.wake']({ machine })) };
  const fleet = await acts['polyflow.gate.fleet']({ machine, fromBuildId });
  const verdict = await acts['polyflow.gate.vet']({ oldDir, newDir, fleet, allowEmptyFleet });
  const summary = { machine, runs: fleet.length, lanes: verdict.lanes, counts: verdict.counts, decisions: verdict.decisions.map(({ workflowId, decision, failed }) => ({ workflowId, decision, failed })) };
  if (!verdict.ok) {
    throw ApplicationFailure.create({
      type: 'PolyflowGateRefused',
      nonRetryable: true,
      message: verdict.refused ?? `${verdict.counts.pin ?? 0} run(s) of '${machine}' would have to stay on the old version: ${verdict.decisions.filter((d) => d.decision === 'pin').map((d) => `${d.workflowId} (${(d.failed ?? []).map((f) => f.gate).join(', ')})`).join('; ')}`,
      details: [summary],
    });
  }
  const applied = apply ? await acts['polyflow.gate.apply']({ decisions: verdict.decisions, toBuildId, onVersionChange }) : null;
  return { ...summary, applied };
}
