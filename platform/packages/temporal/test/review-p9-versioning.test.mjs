// P9 review — a gated run that waits for the new version (onVersionChange)
// while Temporal suggests Continue-as-New. The dev server here suggests it at
// 40 history events, so the wait meets it quickly; in production the default
// (4K events / 4 MB) meets it on any long-lived run that waits days for a
// promotion. Fails today for the reason in its message.
// See docs/platform/reviews/P9-review.md (VG1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { digest } from '@cognitive-fab/polyflow-kernel';
import { PolyflowPlugin, memorySink } from '../src/index.mjs';
import { fixtures, quiet } from './helpers.mjs';

let env;
before(async () => {
  env = await TestWorkflowEnvironment.createLocal({ server: { extraArgs: ['--dynamic-config-value', 'limit.historyCount.suggestContinueAsNew=40'] } });
});
after(async () => { await env?.teardown(); });

const BRIEF = fileURLToPath(new URL('../../../examples/customer-brief/', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, n = 100) {
  for (let i = 0; i < n; i++) { let v = null; try { v = await fn(); } catch { v = null; } if (v) return v; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}

test('VG1: a run told to wait for the new version keeps waiting, on its own state, when Continue-as-New is suggested', async () => {
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'rv9-vg1', workflowsPath: `${fixtures}governed-workflows.mjs`, activities: {}, maxCachedWorkflows: 0,
    bundlerOptions: { logger: quiet },
    plugins: [new PolyflowPlugin({ sink: memorySink(), machines: { 'customer-brief': BRIEF }, allowUncertified: true, externalMode: 'always', onConflict: () => {}, onError: () => {} })],
  });
  await worker.runUntil(async () => {
    const wf = 'rv9-vg1';
    const h = await env.client.workflow.start('GovernedWorkflow', { taskQueue: 'rv9-vg1', workflowId: wf, args: [{ machine: 'customer-brief', input: {} }], workflowExecutionTimeout: '60s' });
    const g = env.client.workflow.getHandle(wf);
    try {
      const next = (kind) => until(async () => (await g.query('polyflow.state')).orders.find((o) => o.kind === kind) ?? null, kind);
      const agent = { id: 'alice', roles: ['agent'] };
      let o = await next('fetch_tickets');
      await g.executeUpdate('polyflow.report', { args: [{ orderId: o.orderId, ok: true, result: { count: 3 }, actor: agent }] });
      o = await next('draft_brief');
      await g.executeUpdate('polyflow.report', { args: [{ orderId: o.orderId, ok: true, result: {}, actor: agent }] });
      const approval = await next('request_approval');
      const s = await g.query('polyflow.state');
      const first = (await g.describe()).runId;
      // The gate (PolyflowGateWorkflow with onVersionChange) tells the run to move,
      // with a migrated state, once the new version is current. It never becomes current here.
      await g.executeUpdate('polyflow.migrate', { args: [{ snapshot: { ...s.state, ticketCount: 7 }, from: digest(s.state), onVersionChange: true }] });
      // The run lives on while it waits: a person claims (and re-claims) the approval.
      for (let i = 0; i < 12 && (await g.describe()).runId === first; i++) {
        await g.executeUpdate('polyflow.claim', { args: [{ orderId: approval.orderId, actor: { id: 'dana', roles: ['human'] } }] }).catch(() => {});
        await sleep(100);
      }
      const now = await g.query('polyflow.state');
      const moved = (await g.describe()).runId !== first;
      assert.ok(now.migrationPending && now.state.ticketCount === 3,
        `VG1: ${moved ? 'the run continued as new' : 'the run'} without any version change, and now holds ${JSON.stringify(now.state)} with migrationPending ${JSON.stringify(now.migrationPending)}: `
        + 'the main loop hands over on continueAsNewSuggested, and handOver() carries pendingMigration.snapshot (computed for the NEW version) onto the OLD one, then forgets the migration. With a shape change the old version cannot hold it and the run is quarantined');
    } finally {
      await g.terminate('review done').catch(() => {});
    }
  });
});
