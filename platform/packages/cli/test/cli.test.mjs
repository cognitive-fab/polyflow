import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultPayloadConverter } from '@temporalio/common';
import { openLedger } from '@cognitive-fab/polyflow-kernel';
import { fileSink, runPaths, signHead, generateSigningKey, LEDGER_HEADER } from '@cognitive-fab/polyflow-temporal';
import { main } from '../src/main.mjs';

const RUN = { ns: 'acme', wf: 'brief/2026-09-22', run: 'r1' };

function fixture({ sign = true, closed = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-cli-'));
  const key = generateSigningKey('ci');
  writeFileSync(join(dir, 'trust.json'), JSON.stringify({ ci: key.publicKeyPem }));
  const l = openLedger({ run: RUN });
  l.append('admission', { level: 'observe' }, 1);
  l.append('proposal', { id: 'p1', action: 'post' }, 2);
  l.append('verdict', { proposal: 'p1', outcome: 'allowed', rules: [] }, 2);
  l.append('effect', { id: 'e1', kind: 'post' }, 2);
  const sink = fileSink(join(dir, 'ledger'));
  const batch1 = l.drain();
  sink.write(batch1, sign ? signHead(RUN, l.head(), key) : null);
  l.append('observation', { effect: 'e1', ok: true }, 3);
  if (closed) l.append('closure', { outcome: 'completed' }, 4);
  sink.write(l.drain(), sign ? signHead(RUN, l.head(), key) : null);
  return { dir, file: runPaths(join(dir, 'ledger'), RUN).events, trust: join(dir, 'trust.json'), events: l.events() };
}

const run = (argv) => { const lines = []; const code = main(argv, (x) => lines.push(x)); return { code, text: lines.join('\n') }; };

test('verify passes a consistent, signed ledger and says what that does and does not mean', () => {
  const f = fixture();
  const r = run(['verify', f.file, '--trust', f.trust]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /chain {7}intact through seq 5/);
  assert.match(r.text, /OK — consistent, closed and signed/);
  assert.match(r.text, /A consistency check, not a proof/);
});

test('verify names the first bad link when an event is edited', () => {
  const f = fixture();
  const lines = readFileSync(f.file, 'utf-8').trim().split('\n');
  const e = JSON.parse(lines[2]);
  e.body.outcome = 'denied';
  lines[2] = JSON.stringify(e);
  writeFileSync(f.file, lines.join('\n') + '\n');
  const r = run(['verify', f.file, '--trust', f.trust]);
  assert.equal(r.code, 1);
  assert.match(r.text, /BROKEN at seq 2: hash does not match content/);
});

test('verify refuses an unsigned ledger rather than passing it', () => {
  const f = fixture({ sign: false });
  const r = run(['verify', f.file, '--trust', f.trust]);
  assert.equal(r.code, 1);
  assert.match(r.text, /no trusted signed head anchors this chain/);
});

test('verify refuses a head signed by a key the auditor does not trust', () => {
  const f = fixture();
  writeFileSync(f.trust, JSON.stringify({ ci: generateSigningKey('ci').publicKeyPem }));
  const r = run(['verify', f.file, '--trust', f.trust, '--json']);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.text).signatures[0].reason, 'signature does not verify');
});

test('export rebuilds the ledger from a history in the CLI JSON shape (base64 payloads)', () => {
  const f = fixture();
  const p = defaultPayloadConverter.toPayload({ events: f.events, head: null });
  const b64 = (u) => Buffer.from(u).toString('base64');
  const history = {
    events: [
      { eventId: '5', activityTaskScheduledEventAttributes: { header: { fields: { [LEDGER_HEADER]: {
        metadata: Object.fromEntries(Object.entries(p.metadata).map(([k, v]) => [k, b64(v)])), data: b64(p.data),
      } } } } },
    ],
  };
  const hfile = join(f.dir, 'history.json');
  writeFileSync(hfile, JSON.stringify(history));
  const out = join(f.dir, 'rebuilt');
  const r = run(['export', hfile, '--out', out]);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(fileSink(out).read(RUN).events, f.events);
});

test('usage errors exit 2, not 1', () => {
  assert.equal(run(['verify']).code, 2);
  assert.equal(run(['frobnicate']).code, 2);
});

test('verify refuses a ledger with no closure unless the run is declared open', () => {
  const f = fixture({ closed: false });
  assert.equal(run(['verify', f.file, '--trust', f.trust]).code, 1);
  const open = run(['verify', f.file, '--trust', f.trust, '--allow-open']);
  assert.equal(open.code, 0, open.text);
  assert.match(open.text, /OK \(open\)/);
});

test('verify treats an unparseable line as a finding, not something to skip', () => {
  const f = fixture();
  writeFileSync(f.file, `${readFileSync(f.file, 'utf-8')}{"torn": \n`);
  const r = run(['verify', f.file, '--trust', f.trust]);
  assert.equal(r.code, 1);
  assert.match(r.text, /not a JSON line/);
});

test('a history-derived ledger verifies only as consistent-and-unsigned, and says so', () => {
  const f = fixture({ sign: false });
  const r = run(['verify', f.file, '--unsigned']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /CONSISTENT, UNSIGNED/);
});
