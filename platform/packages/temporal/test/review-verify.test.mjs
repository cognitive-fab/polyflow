// Adversarial review (P0/P1): the exporter's signer and verifyBundle.
// No Temporal server needed. Each test failed against the P1 code and is kept
// as a regression test; each names a finding in docs/platform/reviews/P0-P1-review.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPayloadConverter } from '@temporalio/common';
import { openLedger } from '@cognitive-fab/polyflow-kernel';
import {
  exporter, memorySink, signHead, verifyHead, verifyBundle, generateSigningKey, LEDGER_HEADER,
} from '../src/index.mjs';

const key = generateSigningKey('deploy');
const trust = { deploy: key.publicKeyPem };
const RUN = { ns: 'default', wf: 'victim', run: 'r-victim' };

/** A genuine run: two carriers, each exported with a signed head, like the plugin does. */
function genuine() {
  const l = openLedger({ run: RUN });
  const sink = memorySink();
  l.append('admission', { level: 'observe', policy: null }, 1);
  l.append('proposal', { id: 'p1', action: 'think' }, 2);
  l.append('verdict', { proposal: 'p1', outcome: 'allowed', rules: [] }, 2);
  l.append('effect', { id: 'e1', kind: 'think' }, 2);
  sink.write(l.drain(), signHead(RUN, l.head(), key));
  l.append('observation', { effect: 'e1', ok: true }, 3);
  l.append('proposal', { id: 'p2', action: 'wire_money' }, 4);
  l.append('verdict', { proposal: 'p2', outcome: 'allowed', rules: [] }, 4);
  l.append('effect', { id: 'e2', kind: 'wire_money' }, 4);
  l.append('observation', { effect: 'e2', ok: true }, 5);
  l.append('closure', { outcome: 'completed' }, 6); // the plugin closes every execution (fix for V1)
  sink.write(l.drain(), signHead(RUN, l.head(), key));
  return sink.read(RUN);
}

// Finding V1: dropping the tail (and the last head) still verifies OK.
test('review V1: truncating the tail after an earlier signed head is detected', () => {
  const { events, heads } = genuine();
  assert.equal(verifyBundle({ events, heads, trust }).ok, true);
  // Attacker drops seq 4..8 (the wire_money effect) and the last head line.
  const r = verifyBundle({ events: events.slice(0, 4), heads: heads.slice(0, 1), trust });
  assert.equal(r.ok, false, 'a ledger with its last five events removed verifies OK');
});

// Finding V2: anyone can APPEND well-formed events after the last signed head.
test('review V2: events appended after the last signed head are not accepted as verified', () => {
  const { events, heads } = genuine();
  const last = events.at(-1);
  const forged = openLedger({ run: RUN, head: { seq: last.seq, hash: last.hash } });
  forged.append('proposal', { id: 'p3', action: 'approve_refund' }, 6);
  forged.append('verdict', { proposal: 'p3', outcome: 'allowed', rules: [] }, 6);
  const r = verifyBundle({ events: [...events, ...forged.events()], heads, trust });
  assert.equal(r.ok, false, `forged tail accepted; signedThrough=${r.signedThrough}, chain head=${r.chain.head?.seq}`);
});

/** Drive the activity-side exporter the way the worker does. */
async function deliver(sink, payload, activityRun) {
  const factory = exporter({ sink, signingKey: key, onError: (e) => { throw e; } });
  const ctx = { info: { workflowExecution: { workflowId: activityRun.wf, runId: activityRun.run }, workflowNamespace: activityRun.ns } };
  await factory(ctx).inbound.execute({ headers: { [LEDGER_HEADER]: defaultPayloadConverter.toPayload(payload) } }, async () => 'ok');
}

// Finding E1: the exporter signs whatever run the header claims — it never
// checks the events belong to the workflow that scheduled the activity. Any
// workflow on the worker can mint a deployment-key-signed ledger for any run.
test('review E1: the exporter refuses (or does not sign) a delta for a run other than the activity\'s', async () => {
  const sink = memorySink();
  const l = openLedger({ run: RUN }); // attacker computes the victim's chain from public data
  l.append('admission', { level: 'observe', policy: null }, 1);
  l.append('proposal', { id: 'p1', action: 'nothing-happened-here' }, 2);
  // The exporter reports the refusal through onError (which throws here).
  await deliver(sink, { events: l.drain(), head: l.head() }, { ns: 'default', wf: 'attacker', run: 'r-attacker' }).catch(() => {});
  const { events, heads } = sink.read(RUN);
  const r = verifyBundle({ events, heads, trust });
  assert.equal(r.ok, false, 'a ledger for run "victim" written from run "attacker" verifies as signed by the deployment key');
});

// Finding E2: the exporter signs the head CLAIMED in the payload, not the head
// of the events it verified.
test('review E2: the exporter only signs the head of the events it verified', async () => {
  const sink = memorySink();
  const l = openLedger({ run: RUN });
  l.append('admission', { level: 'observe', policy: null }, 1);
  const events = l.drain();
  const claimed = { seq: 41, hash: 'sha256:' + 'ab'.repeat(32) };
  await deliver(sink, { events, head: claimed }, RUN);
  const signed = sink.read(RUN).heads[0];
  assert.ok(signed, 'a head was signed');
  assert.ok(verifyHead(signed, trust).ok);
  assert.deepEqual({ seq: signed.seq, hash: signed.hash }, { seq: events.at(-1).seq, hash: events.at(-1).hash },
    `the deployment key signed an arbitrary head ${JSON.stringify(claimed)}`);
});

// Finding E3: the exporter checks only that a delta chains internally, never
// that it continues from what the sink already holds (tech spec §5.3).
test('review E3: the exporter reports a delta that does not continue the sink\'s chain', async () => {
  const sink = memorySink();
  const errors = [];
  const factory = exporter({ sink, signingKey: key, onError: (e) => errors.push(e), onConflict: (_r, s) => errors.push(s) });
  const l = openLedger({ run: RUN });
  l.append('admission', {}, 1);
  const first = l.drain();
  l.append('proposal', { id: 'p1' }, 2);
  l.drain(); // this carrier is "lost" (e.g. a child-workflow header, see T4)
  l.append('verdict', { proposal: 'p1', outcome: 'allowed', rules: [] }, 2);
  const third = l.drain();
  for (const events of [first, third]) {
    await factory({}).inbound.execute({ headers: { [LEDGER_HEADER]: defaultPayloadConverter.toPayload({ events, head: { seq: events.at(-1).seq, hash: events.at(-1).hash } }) } }, async () => 'ok');
  }
  assert.ok(errors.length > 0, 'a gap at seq 1 was accepted and signed silently');
});
