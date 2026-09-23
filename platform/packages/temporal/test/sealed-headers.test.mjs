// P2.6 — sealed ledger headers (NFR-7). Temporal's payload codecs skip
// headers, so with a data key configured the ledger delta and the
// Continue-as-New head are sealed in the workflow (ChaCha20-Poly1305, pure JS)
// and opened by the exporter, the next execution and `polyflow export`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { verifyChain } from '@cognitive-fab/polyflow-kernel';
import { PolyflowPlugin, memorySink, ledgerFromHistory } from '../src/index.mjs';
import { startEnv, runWith, fixtures } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.teardown(); });

const headerKey = { keyId: 'dk-2026-09', key: randomBytes(32).toString('base64') };
const policy = {
  policy: 'sealed', version: 1,
  effects: { think: { kind: 'think' }, search: { kind: 'search' }, post: { kind: 'post', class: 'irreversible' } },
  rules: [{ id: 'one-post', type: 'at-most', guards: 'post', n: 1 }],
};

test('with a data key, history holds no ledger plaintext, and the sink and export still verify', async () => {
  const sink = memorySink();
  const { history } = await runWith(env, {
    taskQueue: 'p26-a', workflowId: 'p26-a', workflowsPath: `${fixtures}agent-workflows.mjs`,
    plugins: [new PolyflowPlugin({ level: 'guard', policy, sink, headerKey })], workflow: 'agentLoop', args: [{ steps: 3 }],
  });
  // Every header payload in the history, as text.
  const raw = history.events.flatMap((e) => Object.values(e.activityTaskScheduledEventAttributes?.header?.fields ?? {}))
    .map((p) => Buffer.from(p.data).toString('utf-8')).join('\n');
  assert.ok(raw.length > 0, 'the activities carried headers');
  for (const plaintext of ['"kind":"verdict"', '"kind":"effect"', 'one-post', '"argsDigest"']) {
    assert.ok(!raw.includes(plaintext), `history carries ${plaintext} in plaintext`);
  }
  assert.ok(raw.includes('chacha20-poly1305'), 'the headers are sealed envelopes');
  const { events } = sink.read(sink.runs()[0]);
  assert.ok(events.some((e) => e.kind === 'verdict'), 'the exporter opened the headers');
  assert.equal(verifyChain(events).ok, true);
  const exported = ledgerFromHistory(history, { headerKeys: { [headerKey.keyId]: headerKey.key } });
  assert.deepEqual(exported.map((e) => e.hash), events.filter((e) => exported.some((x) => x.seq === e.seq)).map((e) => e.hash));
  assert.throws(() => ledgerFromHistory(history), /sealed with key 'dk-2026-09'/, 'without the key, export says why');
  assert.throws(() => ledgerFromHistory(history, { headerKeys: { [headerKey.keyId]: randomBytes(32).toString('base64') } }), /does not open/);
});

test('a sealed head crosses Continue-as-New: one chain, and the guard state with it', async () => {
  const sink = memorySink();
  const { result } = await runWith(env, {
    taskQueue: 'p26-b', workflowId: 'p26-b', workflowsPath: `${fixtures}review-p4p5-workflows.mjs`,
    activities: { ask_approval: async () => ({}), slack_send: async () => ({}) },
    plugins: [new PolyflowPlugin({
      level: 'guard', sink, headerKey,
      policy: {
        policy: 'gc', version: 1,
        effects: { slack_send: { kind: 'post', class: 'irreversible', labels: ['egress'] }, ask_approval: { kind: 'approval', class: 'none' } },
        rules: [{ id: 'no-post-without-approval', type: 'requires-prior', guards: 'post', prior: 'approval' }, { id: 'at-most-one-post', type: 'at-most', guards: 'post', n: 1 }],
      },
    })],
    workflow: 'postAcrossContinueAsNew', args: [{}],
  });
  assert.equal(result.secondPost, 'denied', 'the guard state was carried inside the sealed head');
  const runs = sink.runs();
  assert.equal(runs.length, 1, 'one chain across both executions');
  assert.equal(verifyChain(sink.read(runs[0]).events).ok, true);
});
