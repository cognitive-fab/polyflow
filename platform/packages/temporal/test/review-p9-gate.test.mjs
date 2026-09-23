// P9 review — the policy ramp gate's fleet read (plan P4.6), with a stub
// client: no server. Each test fails today for the reason in its message.
// See docs/platform/reviews/P9-review.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitPolicy, createGuard } from '@cognitive-fab/polyflow-kernel';
import { gateActivities } from '../src/gate-activities.mjs';

const OLD = {
  policy: 'comms', version: 1,
  effects: { slack_send: { kind: 'post', class: 'irreversible' }, ask_approval: { kind: 'approval', class: 'none' } },
  rules: [{ id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' }],
};
const NEW = { ...OLD, version: 2, rules: [...OLD.rules, { id: 'one-post', type: 'at-most', guards: 'post', n: 0, forbid: true }] };
const enforced = (p) => admitPolicy({ ...p, unlabelled: 'deny' });

/** A namespace with these running workflows; `answer(id)` is what their polyflow.guard query returns, or throws. */
function stubClient(ids, answer) {
  return {
    workflow: {
      async* list() { for (const workflowId of ids) yield { workflowId, runId: `${workflowId}-run` }; },
      getHandle: (workflowId) => ({ query: async () => answer(workflowId) }),
    },
  };
}

/** A run that holds an approval: under OLD it may post now; under NEW it may not. */
function approvedGuard() {
  const p = enforced(OLD);
  const g = createGuard(p);
  const c = { kind: 'approval', class: 'none', labels: [], declared: true, target: 'ask_approval', argsDigest: 'd', at: 1 };
  return g.observe(g.commit(g.init(), c, g.decide(g.init(), c)), { kind: 'approval', ok: true });
}

test('GF1: a governed run whose guard cannot be read (its worker is restarting, the query times out) fails the gate; it is not skipped as "not governed"', async () => {
  const acts = gateActivities(stubClient(['ramp-a'], () => { throw new Error('context deadline exceeded: no worker polling'); }));
  const r = await acts['polyflow.gate.policy']({ oldPolicy: OLD, newPolicy: NEW, query: null });
  assert.equal(r.ok, false, `GF1: the ramp passes with an unread run (${JSON.stringify(r)}): gate-activities.mjs skips any query error as "not governed", which is exactly what a run looks like while the workers are being rolled`);
});

test('GF2: an empty fleet is refused unless the operator says it is expected (as the G2 gate does)', async () => {
  // Every run reports a policy digest the operator did not name: a wrong
  // `oldPolicy`, or a fleet half-ramped already. All are filtered out.
  const acts = gateActivities(stubClient(['ramp-a', 'ramp-b'], () => ({ level: 'guard', policy: 'sha256:some-other-policy', guard: approvedGuard(), at: 2 })));
  const r = await acts['polyflow.gate.policy']({ oldPolicy: OLD, newPolicy: NEW, query: null });
  assert.equal(r.ok, false, `GF2: the ramp passes having vetted nothing (${JSON.stringify(r)}): runs under any other policy digest are dropped, and an empty fleet is ok: true`);
});

test('GF3: the positive control — a readable run under the old policy that loses post is pinned', async () => {
  const acts = gateActivities(stubClient(['ramp-a'], () => ({ level: 'guard', policy: enforced(OLD).digest, guard: approvedGuard(), at: 2 })));
  const r = await acts['polyflow.gate.policy']({ oldPolicy: OLD, newPolicy: NEW, query: null });
  assert.equal(r.ok, false);
  // (Response RP1: the gate now names the ACTIVITY taken back, not its kind.)
  assert.deepEqual(r.decisions, [{ workflowId: 'ramp-a', decision: 'pin', revoked: ['slack_send'] }]);
});
