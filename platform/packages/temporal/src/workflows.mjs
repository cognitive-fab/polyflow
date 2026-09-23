// Workflow-side exports. A Temporal workflows module re-exports these:
//
//   export * from '@cognitive-fab/polyflow-temporal/workflows';
//
// (TypeScript workers bundle workflows from one module, so a plugin cannot
// register workflow types on its own — the Temporal plugins guide's rule.)
export { GovernedWorkflow, stateQuery, journalQuery, proposeUpdate, proposeSignal, releaseUpdate, migrateUpdate, versionSignal, reportUpdate, claimUpdate, wakeSignal } from './governed-workflow.mjs';
export { PolyflowGateWorkflow, PolyflowPolicyGateWorkflow } from './gate-workflow.mjs';
export { proposePlan } from './plans.mjs';
