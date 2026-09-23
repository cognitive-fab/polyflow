// Client-side helpers for governed runs — FR-GOV.5; technical spec §5.4 "Start".
//
// A governed run's workflow id is DERIVED from validated input by the
// machine's key template: polyflow/<machine>/<key>. Starting and re-attaching
// are one call. A caller — often a model — cannot rename its way to a second
// run of work that already happened.

import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { parseKeyPolicy, deriveKey, KeyError } from '@cognitive-fab/polyflow-kernel';

// Each part is encoded, so a '/' in a machine name or a key cannot make two
// different (machine, key) pairs share an id (P2/P3 review K1).
export const workflowIdFor = (machine, key) => `polyflow/${encodeURIComponent(machine)}/${encodeURIComponent(key)}`;

/** Options a caller may not set: they would decide the run's identity instead of the input (review C1). */
const IDENTITY_OPTIONS = ['workflowId', 'workflowIdReusePolicy', 'workflowIdConflictPolicy', 'args', 'taskQueue'];

/**
 * Start a governed run, or attach to the one its input already names.
 *
 * @param {import('@temporalio/client').Client} client
 * @param {object} o
 * @param {{name:string, key?:object}} o.descriptor  the machine's polyflow.workflow.json (or loadMachineDir().descriptor)
 * @param {object} o.input
 * @param {string} o.taskQueue
 * @param {string} [o.key]     only for machines that declare no key template
 * @returns {Promise<{handle, workflowId, key, status:'started'|'attached'|'complete', note?}>}
 */
export async function startGoverned(client, { descriptor, input = {}, taskQueue, key: given, mode = 'worker', ...options }) {
  const machine = descriptor.name;
  const overridden = IDENTITY_OPTIONS.filter((k) => k in options);
  if (overridden.length) throw new KeyError(`startGoverned derives the run's identity; it does not take ${overridden.join(', ')}`);
  const policy = parseKeyPolicy(descriptor.key);
  let key;
  let note;
  if (policy) {
    key = deriveKey(policy, input);
    if (given && given !== key) note = `key '${given}' ignored: this workflow's runs are identified by ${policy.template} = '${key}', derived from the input you gave.`;
  } else if (given) {
    key = String(given);
  } else {
    throw new KeyError(`machine '${machine}' declares no key template, so a key must be given`);
  }
  const workflowId = workflowIdFor(machine, key);
  const complete = () => ({
    handle: client.workflow.getHandle(workflowId), workflowId, key, status: 'complete',
    note: 'this run is finished. Do NOT start another run of the same work under a different key — report what this one did.',
  });
  let existing = null;
  try {
    existing = await client.workflow.getHandle(workflowId).describe();
  } catch (err) {
    if (!(err instanceof WorkflowNotFoundError)) throw err;
  }
  if (existing && existing.status.name === 'COMPLETED') return complete();
  if (existing && existing.status.name !== 'RUNNING') {
    // Failed, terminated, cancelled or timed out is not "finished": say which,
    // and do not pretend the work was done (review C2). A new run of the same
    // work under the same key is an operator's decision, not the caller's.
    return {
      handle: client.workflow.getHandle(workflowId), workflowId, key, status: 'ended', ended: existing.status.name,
      note: `the run for this key ended ${existing.status.name} without completing. Do not start the same work under another key; ask an operator.`,
    };
  }
  try {
    const handle = await client.workflow.start('GovernedWorkflow', {
      ...options,
      taskQueue,
      workflowId,
      args: [{ machine, input, mode }],
      // Running: attach to it. Closed: refuse.
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
    });
    // A start that races another start for the same key attaches through
    // USE_EXISTING and is reported 'started': harmless, since both callers now
    // hold the same single run.
    return { handle, workflowId, key, status: existing ? 'attached' : 'started', note };
  } catch (err) {
    // It closed between the describe and the start.
    if (err instanceof WorkflowExecutionAlreadyStartedError) return complete();
    throw err;
  }
}
