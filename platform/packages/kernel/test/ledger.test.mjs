import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, verifyChain, hashOf } from '../src/ledger.mjs';

const RUN = { ns: 'acme', wf: 'brief-2026-09-22', run: 'r-1' };

function sample() {
  const l = openLedger({ run: RUN });
  l.append('admission', { level: 'observe', policy: null }, 1000);
  l.append('proposal', { id: 'p1', source: 'agent', action: 'fetch' }, 1001, 5);
  l.append('verdict', { proposal: 'p1', outcome: 'allowed', rules: [] }, 1001);
  l.append('effect', { id: 'e1', kind: 'fetch', activityType: 'fetch_url' }, 1001, 5);
  l.append('observation', { effect: 'e1', ok: true }, 1002, 7);
  return l;
}

test('a fresh chain verifies and reports its head', () => {
  const events = sample().events();
  const v = verifyChain(events);
  assert.equal(v.ok, true);
  assert.equal(v.head.seq, 4);
  assert.equal(v.head.hash, events[4].hash);
});

test('the chain is deterministic: the same appends give the same hashes', () => {
  assert.deepEqual(sample().events().map((e) => e.hash), sample().events().map((e) => e.hash));
});

test('altering any field of any event is caught at that event', () => {
  const events = sample().events();
  const tampered = structuredClone(events);
  tampered[2].body.outcome = 'denied';
  assert.deepEqual(verifyChain(tampered), { ok: false, seq: 2, reason: 'hash does not match content' });
});

test('re-hashing a tampered event still breaks the next link', () => {
  const tampered = structuredClone(sample().events());
  tampered[2].body.outcome = 'denied';
  tampered[2].hash = hashOf(tampered[2]);
  assert.deepEqual(verifyChain(tampered), { ok: false, seq: 3, reason: 'prev does not match the preceding event' });
});

test('a dropped event is named as missing; a swapped pair as out of order', () => {
  const events = sample().events();
  assert.deepEqual(verifyChain([...events.slice(0, 2), ...events.slice(3)]), { ok: false, seq: 2, reason: 'missing event (next present is 3)' });
  assert.deepEqual(verifyChain([events[0], events[2], events[1]]).seq, 1);
});

test('an event from another run is refused', () => {
  const other = openLedger({ run: { ...RUN, run: 'r-2' } });
  other.append('admission', {}, 1);
  const events = sample().events();
  assert.equal(verifyChain([events[0], { ...other.events()[0], seq: 1 }]).reason, 'event belongs to another run');
});

test('drain hands each event to exactly one carrier', () => {
  const l = sample();
  assert.equal(l.drain().length, 5);
  assert.equal(l.drain().length, 0);
  l.append('proposal', { id: 'p2' }, 2000);
  assert.deepEqual(l.drain().map((e) => e.seq), [5]);
});

test('a ledger resumed from its head after Continue-as-New continues the same chain', () => {
  const a = sample();
  const b = openLedger({ run: RUN, head: a.head() });
  b.append('proposal', { id: 'p9' }, 3000);
  assert.equal(verifyChain([...a.events(), ...b.events()]).ok, true);
  assert.equal(verifyChain(b.events(), { from: a.head() }).ok, true);
});

test('unknown kinds and missing workflow time are refused at append', () => {
  const l = openLedger({ run: RUN });
  assert.throws(() => l.append('gossip', {}, 1), /unknown ledger event kind/);
  assert.throws(() => l.append('proposal', {}, undefined), /workflow time/);
});

test('an empty ledger does not verify', () => {
  assert.equal(verifyChain([]).ok, false);
});
