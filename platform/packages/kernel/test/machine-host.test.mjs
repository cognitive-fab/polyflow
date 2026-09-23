import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHost } from '../src/index.mjs';

const require = createRequire(import.meta.url);
const dir = new URL('../../../examples/customer-brief/', import.meta.url);
const file = (name) => fileURLToPath(new URL(name, dir));
const load = () => createHost({
  module: require(file('machine.cjs')),
  contract: JSON.parse(readFileSync(new URL('contract.json', dir), 'utf-8')),
  mapper: require(file('effects.cjs')).effects,
  manifest: JSON.parse(readFileSync(new URL('effects.manifest.json', dir), 'utf-8')),
});

test('the happy path orders one step at a time and ends terminal', () => {
  const h = load();
  let s = h.init();
  assert.deepEqual(s, { briefState: 'idle', ticketCount: 0, reason: '' });
  const kinds = [];
  for (const [action, data] of [['START', {}], ['TICKETS_READY', { count: 3 }], ['DRAFT_READY', {}], ['APPROVED', {}], ['POST_DONE', {}]]) {
    const r = h.step(s, action, data, { runKey: 'r1', seq: kinds.length, now: 1000 });
    assert.equal(r.stepKind, 'accepted', action);
    kinds.push(...r.effects.map((e) => e.kind));
    s = r.post;
  }
  assert.deepEqual(kinds, ['fetch_tickets', 'draft_brief', 'request_approval', 'post_brief']);
  assert.equal(s.briefState, 'posted');
  assert.equal(h.isTerminal(s), true);
});

test('entering review arms the approval timer at workflow time, not wall time', () => {
  const h = load();
  const s = { briefState: 'drafting', ticketCount: 3, reason: '' };
  const r = h.step(s, 'DRAFT_READY', {}, { runKey: 'r', seq: 3, now: 5000 });
  assert.deepEqual(r.timers, [{ key: 'approvalWindow', fireAt: 5000 + 8 * 3600 * 1000, action: 'DENIED', data: { reason: 'not-ready' } }]);
});

test('a stale completion is an observable reject, never a fault, and changes nothing', () => {
  const h = load();
  const s = { briefState: 'posted', ticketCount: 3, reason: '' };
  const r = h.step(s, 'POST_DONE', {});
  assert.equal(r.stepKind, 'rejected');
  assert.equal(r.reason, 'stale-completion');
  assert.deepEqual(r.post, s);
  assert.deepEqual(r.effects, []);
});

test('an action outside the surface is unhandled, as polyrun journals it, with a reason', () => {
  const r = load().step({ briefState: 'idle', ticketCount: 0, reason: '' }, 'LAUNCH', {});
  assert.equal(r.stepKind, 'unhandled');
  assert.match(r.reason, /not in the machine's action surface/);
});

test('steps do not leak between runs that share the module', () => {
  const h = load();
  const a = h.step(h.init(), 'START', {}).post;
  const b = h.init();
  // Stepping run A must not change what run B's snapshot means.
  h.step(a, 'TICKETS_READY', { count: 2 });
  assert.equal(h.step(b, 'START', {}).post.briefState, 'gathering');
  assert.equal(h.dryRun(b, 'APPROVED', {}).stepKind, 'rejected');
});

test('intent ids are derived from the run, the step and the ordinal', () => {
  const h = load();
  const s = h.init();
  const one = h.step(s, 'START', {}, { runKey: 'run-A', seq: 1 }).effects[0].intentId;
  assert.equal(h.step(s, 'START', {}, { runKey: 'run-A', seq: 1 }).effects[0].intentId, one);
  assert.notEqual(h.step(s, 'START', {}, { runKey: 'run-B', seq: 1 }).effects[0].intentId, one);
});

test('an undeclared effect kind poisons rather than being dropped', () => {
  const base = load();
  const h = createHost({
    module: require(file('machine.cjs')),
    contract: JSON.parse(readFileSync(new URL('contract.json', dir), 'utf-8')),
    mapper: () => [{ kind: 'wire_money', payload: {} }],
    manifest: JSON.parse(readFileSync(new URL('effects.manifest.json', dir), 'utf-8')),
  });
  assert.match(h.step(base.init(), 'START', {}).poisoned, /undeclared kind 'wire_money'/);
});

test('a manifest wired to an action the machine lacks is refused at load', () => {
  assert.throws(() => createHost({
    module: require(file('machine.cjs')),
    contract: {},
    manifest: { effects: { x: { onSuccess: { action: 'NOPE' } } } },
  }), /action 'NOPE' is not in the machine's action surface/);
});
