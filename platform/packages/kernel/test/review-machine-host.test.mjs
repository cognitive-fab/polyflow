// Adversarial review (P0/P1): parity of the machine host with polyrun's
// kernel (polygraph/polyrun/src/kernel.mjs _dispatchInTxn). Failed against the
// P1 code, kept as a regression test; see finding H1 in docs/platform/reviews/P0-P1-review.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHost } from '../src/index.mjs';

const require = createRequire(import.meta.url);
const dir = new URL('../../../examples/customer-brief/', import.meta.url);
const host = () => createHost({
  module: require(fileURLToPath(new URL('machine.cjs', dir))),
  contract: JSON.parse(readFileSync(new URL('contract.json', dir), 'utf-8')),
  mapper: require(fileURLToPath(new URL('effects.cjs', dir))).effects,
  manifest: JSON.parse(readFileSync(new URL('effects.manifest.json', dir), 'utf-8')),
});

// polyrun journals an action outside the surface as step_kind 'unhandled'
// (kernel.mjs:420-423) and an acceptor-less action as 'unhandled' (:451-453).
// The host reports both as 'rejected', so the FR-LED.4 window is not
// byte-compatible with a pr_journal row for the same step.
test('review H1: an action outside the surface is journaled as polyrun does (unhandled)', () => {
  const r = host().step({ briefState: 'idle', ticketCount: 0, reason: '' }, 'LAUNCH', {});
  assert.equal(r.stepKind, 'unhandled');
});

test('review H1: intent ids are derived exactly as polyrun derives them', async () => {
  const { createHash } = await import('node:crypto');
  const sha = (...parts) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  const r = host().step({ briefState: 'idle', ticketCount: 0, reason: '' }, 'START', {}, { runKey: 'inst-1', seq: 1 });
  assert.equal(r.effects[0].intentId, sha('inst-1', '1', 'fetch_tickets', '0'));
});

test('review H1: the host refuses a machine whose state keys disagree with its contract', () => {
  assert.throws(() => createHost({
    module: require(fileURLToPath(new URL('machine.cjs', dir))),
    contract: { stateKeys: [{ name: 'briefState' }, { name: 'ticketCount' }] },
  }), /module keys not in contract: reason/);
});
