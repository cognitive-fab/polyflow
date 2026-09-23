// The gateway's reach and its catalogue (P9 security review SEC-GW1, SEC-GW2).
// No Temporal server: a stub client records what the gateway asks for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/index.mjs';

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const RUN = 'polyflow/customer-brief/2026-06-01';

/** A stub whose one workflow answers as the test says. */
function stubClient({ state = null, type = 'GovernedWorkflow', result = null } = {}) {
  const calls = [];
  const client = {
    workflow: {
      getHandle: (id) => ({
        query: async (name) => {
          calls.push(`query ${name} ${id}`);
          if (name === 'polyflow.journal') return [];
          if (!state) throw new Error('no handler');
          return state;
        },
        describe: async () => ({ type, status: { name: 'COMPLETED' } }),
        result: async () => { calls.push(`result ${id}`); return result; },
        executeUpdate: async (name, { args }) => { calls.push({ update: name, id, args }); return { stepKind: 'accepted', seq: 3 }; },
      }),
    },
  };
  return { client, calls };
}

const tool = (tools, name) => (args) => tools.find((t) => t.name === name).handler(args);
const open = { machine: 'customer-brief', seq: 2, state: {}, orders: [], terminal: false };

test('an instance id must be workflowIdFor(offered machine, key), exactly', async () => {
  const { client, calls } = stubClient({ state: open });
  const { pf } = createGateway({ client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true });
  for (const bad of ['payroll/2026-09', 'polyflow/payroll/x', 'polyflow/customer-brief/a/b', 'polyflow/customer%2Dbrief/k', { id: 1 }]) {
    await assert.rejects(pf.view(bad), /not a run of a workflow this gateway offers/);
  }
  assert.deepEqual(calls, [], 'no handle was touched');
  assert.equal((await pf.view(RUN)).key, '2026-06-01');
});

test('a run must say it is the machine its id names, and a closed run is read only if it is a GovernedWorkflow', async () => {
  const lying = stubClient({ state: { ...open, machine: 'payroll' } });
  await assert.rejects(createGateway({ client: lying.client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true }).pf.view(RUN), /not a run of 'customer-brief'/);
  const plain = stubClient({ type: 'payrollWorkflow', result: { state: { ssn: 'x' } } });
  await assert.rejects(createGateway({ client: plain.client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true }).pf.view(RUN), /not a governed run/);
  assert.ok(!plain.calls.some((c) => String(c).startsWith('result')), 'result() was not read');
  const done = stubClient({ result: { machine: 'customer-brief', seq: 5, state: { briefState: 'posted' } } });
  const v = await createGateway({ client: done.client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true }).pf.view(RUN);
  assert.equal(v.done, true);
  assert.equal(v.state.briefState, 'posted');
});

test('workflow_signal carries the gateway\'s own actor', async () => {
  const { client, calls } = stubClient({ state: open });
  const actor = { id: 'desk', roles: ['agent'] };
  const { tools } = createGateway({ client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true, actor });
  await tool(tools, 'workflow_signal')({ instance: RUN, action: 'CANCEL', data: {} });
  const u = calls.find((c) => c.update === 'polyflow.propose');
  assert.deepEqual(u.args[0].actor, actor);
});

test('the catalogue fails closed without a trust store, and says so when uncertified machines are allowed (SEC-GW2)', async () => {
  const { client } = stubClient();
  const closed = createGateway({ client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF } });
  const [c] = (await tool(closed.tools, 'workflow_list')({})).workflows;
  assert.equal(c.admitted, false);
  await assert.rejects(closed.pf.begin('customer-brief', null, { date: '2026-06-01' }), /not admitted: the gateway has no trust store/);
  const dev = createGateway({ client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true });
  const [d] = (await tool(dev.tools, 'workflow_list')({})).workflows;
  assert.equal(d.admitted, false);
  assert.equal(d.uncertified, true);
});

test('MCP arguments are checked for type and size, and infrastructure errors reach the model as a reference (SEC-MCP1)', async () => {
  const { argumentProblem, errorText } = await import('@cognitive-fab/polyflow/mcp');
  const { client } = stubClient({ state: open });
  const { tools } = createGateway({ client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true });
  const signal = tools.find((t) => t.name === 'workflow_signal');
  assert.match(argumentProblem(signal, { instance: { $ne: 1 }, action: 'X' }), /'instance' must be a string/);
  assert.match(argumentProblem(signal, { instance: RUN, action: 'X', data: 'no' }), /'data' must be an object/);
  assert.match(argumentProblem(signal, { instance: RUN, action: 'X', data: { blob: 'x'.repeat(300_000) } }), /bytes; the limit/);
  assert.match(argumentProblem(signal, { instance: 'x'.repeat(10_000), action: 'X' }), /longer than/);
  assert.equal(argumentProblem(signal, { instance: RUN, action: 'X', data: {} }), null);
  const logged = [];
  class ServiceError extends Error {}
  const text = errorText(new ServiceError('14 UNAVAILABLE: temporal.acme.internal:7233 namespace acme-prod'), (l) => logged.push(l));
  assert.doesNotMatch(text, /acme/);
  const ref = /ref ([0-9a-f]{8})/.exec(text)?.[1];
  assert.ok(ref && logged[0].includes(ref), 'the log carries the same reference');
  assert.match(errorText(Object.assign(new Error('unknown workflow \'x\''), { expected: true })), /unknown workflow/);
});

test('with a principal key, the gateway signs its actor for each action; without one, it sends the actor as a claim', async () => {
  const { generateSigningKey } = await import('@cognitive-fab/polyflow-temporal');
  const { verifyPrincipal, digest } = await import('@cognitive-fab/polyflow-kernel');
  const principalKey = generateSigningKey('desk-issuer');
  const actor = { id: 'desk', roles: ['agent'] };
  const { client, calls } = stubClient({ state: open });
  client.options = { namespace: 'acme' };
  const { tools } = createGateway({ client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true, actor, principalKey });
  await tool(tools, 'workflow_signal')({ instance: RUN, action: 'CANCEL', data: {} });
  const sent = calls.find((c) => c.update === 'polyflow.propose').args[0].actor;
  // Bound to the action AND its data (P9 review PR1).
  assert.deepEqual(sent.body.act, { op: 'propose', wf: RUN, ref: 'CANCEL', digest: digest({}) });
  assert.equal(sent.body.aud, 'acme');
  const v = verifyPrincipal(sent, { trust: { 'desk-issuer': principalKey.publicKeyPem }, now: Date.now(), audience: 'acme', action: { op: 'propose', wf: RUN, ref: 'CANCEL', digest: digest({}) } });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.principal.id, 'desk');
  assert.equal(verifyPrincipal(sent, { trust: { 'desk-issuer': principalKey.publicKeyPem }, now: Date.now(), audience: 'acme', action: { op: 'propose', wf: RUN, ref: 'APPROVE' } }).ok, false, 'bound to its one action');
});
