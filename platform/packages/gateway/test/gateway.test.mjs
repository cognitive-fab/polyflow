// P5 — polyflow's six MCP tools, unchanged, driving a governed run on Temporal
// (FR-AGT.3), and claims when more than one participant works a run (FR-HUM.2).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { PolyflowPlugin, memorySink } from '@cognitive-fab/polyflow-temporal';
import { createGateway } from '../src/index.mjs';

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const WORKFLOWS = fileURLToPath(new URL('../../temporal/test/fixtures/governed-workflows.mjs', import.meta.url));
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error: (...a) => console.error(...a), log() {} };

let env;
let worker;
let running;
before(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  // A governed worker with NO activities for the brief's kinds: in external
  // mode every order is performed by whoever holds the MCP tools.
  worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'gw', workflowsPath: WORKFLOWS, activities: {}, maxCachedWorkflows: 0,
    bundlerOptions: { logger: quiet },
    plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF }, allowUncertified: true, externalMode: 'always' })],
  });
  running = worker.run();
});
after(async () => {
  worker?.shutdown();
  await running?.catch(() => {});
  await env?.teardown();
});

// Who this gateway speaks for: an order addressed to a person (the approval)
// is reported only by someone holding that role (P4/P5 review RP).
const DESK = { id: 'desk', roles: ['agent', 'human'] };

const tool = (tools, name) => (args) => tools.find((t) => t.name === name).handler(args);

test('an MCP agent drives a governed Temporal run to the end with the six unchanged tools', async () => {
  const { tools } = createGateway({ client: env.client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true, actor: DESK });
  const call = (n, a = {}) => tool(tools, n)(a);
  const { workflows } = await call('workflow_list');
  assert.equal(workflows[0].name, 'customer-brief');

  let v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-06-01' } });
  assert.equal(v.instance, 'polyflow/customer-brief/2026-06-01');
  assert.equal(v.next[0].tool, 'github_search_issues');
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: { count: 3 } });
  assert.equal(v.state.briefState, 'drafting');
  assert.equal(v.next[0].tool, 'ask');
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: {} });
  assert.equal(v.next[0].tool, 'ask_user');
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: {} });
  assert.equal(v.next[0].tool, 'slack_send');
  assert.equal(v.next[0].target, '#cs');
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: {} });
  assert.equal(v.state.briefState, 'posted');
  assert.equal(v.done, true);

  // start again: the run is finished, and the tool says so instead of starting another
  await assert.rejects(call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-06-01' } }).then((r) => { if (r.note?.includes('finished') || r.already_complete) throw new Error('complete'); return r; }), /complete/);
});

test('a denial reported as permanent is a result: the run ends denied and nothing is posted', async () => {
  const { tools } = createGateway({ client: env.client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true, actor: DESK });
  const call = (n, a = {}) => tool(tools, n)(a);
  let v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-06-02' } });
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: { count: 2 } });
  v = await call('workflow_report', { order_id: v.next[0].order_id, result: {} });
  v = await call('workflow_report', { order_id: v.next[0].order_id, ok: false, permanent: true, error: 'not-ready' });
  assert.equal(v.state.briefState, 'denied');
  assert.equal(v.next.length, 0);
});

test('a duplicate report is refused, not executed twice', async () => {
  const { tools } = createGateway({ client: env.client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true, actor: DESK });
  const call = (n, a = {}) => tool(tools, n)(a);
  const v = await call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-06-03' } });
  const order = v.next[0].order_id;
  const first = await call('workflow_report', { order_id: order, result: { count: 1 } });
  assert.equal(first.state.briefState, 'drafting');
  const again = await call('workflow_report', { order_id: order, result: { count: 1 } });
  assert.match(again.error ?? '', /not open|already/);
});

test('with two participants, one claim wins, the loser is told who holds it, and only the holder can report', async () => {
  const alice = createGateway({ client: env.client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true, actor: { id: 'alice', roles: ['agent'] } });
  const bob = createGateway({ client: env.client, taskQueue: 'gw', machines: { 'customer-brief': BRIEF }, allowUncertified: true, actor: { id: 'bob', roles: ['agent'] } });
  const a = (n, x = {}) => tool(alice.tools, n)(x);
  const b = (n, x = {}) => tool(bob.tools, n)(x);
  const v = await a('workflow_start', { workflow: 'customer-brief', input: { date: '2026-06-04' } });
  await b('workflow_state', { instance: v.instance }); // bob sees the same open order
  const order = v.next[0].order_id;
  assert.deepEqual(await a('workflow_claim', { order_id: order }), { claimed: true, holder: 'alice', orderId: order, claimedUntil: (await a('workflow_state', { instance: v.instance })).next[0].claimed_until });
  const refused = await b('workflow_claim', { order_id: order });
  assert.equal(refused.claimed, false);
  assert.equal(refused.holder, 'alice');
  const bobReport = await b('workflow_report', { order_id: order, result: { count: 2 } });
  assert.match(bobReport.error ?? '', /claimed by alice/);
  const aliceReport = await a('workflow_report', { order_id: order, result: { count: 2 } });
  assert.equal(aliceReport.state.briefState, 'drafting');
});
