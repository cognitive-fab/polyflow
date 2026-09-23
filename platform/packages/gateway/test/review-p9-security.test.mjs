// P9 security review — the MCP gateway's reach. No Temporal server: a stub
// client records which workflows the gateway touches. Each test fails today
// for the reason in its message. See docs/platform/reviews/P9-security-review.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/index.mjs';

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));

/** A Temporal client stand-in: every workflow exists, answers, and accepts every Update. */
function stubClient() {
  const touched = [];
  const client = {
    workflow: {
      getHandle: (workflowId) => ({
        executeUpdate: async (name) => { touched.push(`update ${name} -> ${workflowId}`); return { stepKind: 'accepted', seq: 2 }; },
        query: async (name) => {
          touched.push(`query ${name} -> ${workflowId}`);
          if (name === 'polyflow.journal') return [];
          throw new Error('no polyflow.state handler'); // an ordinary, non-governed workflow
        },
        describe: async () => ({ status: { name: 'COMPLETED' } }),
        result: async () => { touched.push(`result -> ${workflowId}`); return { state: { salary: 250000, ssn: '078-05-1120' }, machine: 'payroll', seq: 9 }; },
      }),
    },
  };
  return { client, touched };
}

const call = (tools, name, args) => tools.find((t) => t.name === name).handler(args);

test('SEC-GW1: the gateway acts only on runs of the machines it offers, whatever instance id the model passes', async () => {
  const { client, touched } = stubClient();
  const { tools } = createGateway({ client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF } });
  // A model (or a prompt injection in a ticket it read) names ANOTHER workflow in the namespace.
  await call(tools, 'workflow_signal', { instance: 'payroll/2026-09', action: 'APPROVE', data: {} }).catch(() => {});
  await call(tools, 'workflow_state', { instance: 'payroll/2026-09' }).catch(() => {});
  const foreign = touched.filter((t) => t.endsWith('-> payroll/2026-09'));
  assert.deepEqual(foreign, [], `SEC-GW1: the gateway, configured for 'customer-brief' only, sent ${foreign.join('; ')}. workflow_signal proposes any action to any workflow id (with no actor), and workflow_state returns another workflow's result to the model`);
});
