// P6-P8 review — admission of machines that use the judge (FR-JEV.1) and the
// refund-triage example's guarantees. Each test fails today for the reason in
// its message. See docs/platform/reviews/P6-P8-review.md.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/main.mjs';

const TRIAGE = fileURLToPath(new URL('../../../examples/refund-triage/', import.meta.url));
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function copy() {
  const dir = mkdtempSync(join(fileURLToPath(new URL('../../../examples/', import.meta.url)), '.tmp-review-p6p8-'));
  cpSync(TRIAGE, dir, { recursive: true });
  made.push(dir);
  return dir;
}
const edit = (file, from, to) => {
  const src = readFileSync(file, 'utf-8');
  assert.ok(src.includes(from), `fixture drift: '${from}' not found in ${file}`);
  writeFileSync(file, src.replace(from, to));
};
const run = async (argv) => { const lines = []; const code = await main(argv, (x) => lines.push(x)); return { code, text: lines.join('\n') }; };

const CLEAR = 'const clear = proposal.reasonStated === true && proposal.fraud === false;';

test('JA1: a machine that reads the fraud question\'s abstention as "no fraud" is refused', async () => {
  // The same bug admit.test.mjs refuses for the reason question, on the other
  // question. The judge abstains on fraud (no fact) and the machine refunds on
  // its own word. no-refund-unless-the-judge-cleared-it would catch it, but the
  // machine's ASSESSED domain lists only 3 of the 9 combinations the contract
  // declares, and {reasonStated: true, fraud: absent} is not one of them.
  const dir = copy();
  edit(join(dir, 'machine.cjs'), CLEAR, 'const clear = proposal.reasonStated === true && proposal.fraud !== true;');
  const r = await run(['admit', dir]);
  assert.equal(r.code, 1, `JA1: admitted — the judge's silence on fraud now moves money:\n${r.text}`);
});

test('JA2: a machine that refunds when the judge REFUTES that a reason was given is refused', async () => {
  const dir = copy();
  edit(join(dir, 'machine.cjs'), CLEAR, 'const clear = proposal.reasonStated !== null && proposal.fraud === false;');
  const r = await run(['admit', dir]);
  assert.equal(r.code, 1, `JA2: admitted — reasonStated: false is not in the explored domain:\n${r.text}`);
});

test('JA3: an observation battery the kernel would refuse is not certified', async () => {
  // parseBattery refuses `choice` and inverted bands; admission never calls it.
  // The certificate then lists `observations` as a checked artefact.
  const dir = copy();
  writeFileSync(join(dir, 'observations.json'), JSON.stringify({ batteries: { refund: { questions: {
    reason_stated: { type: 'choice', instructions: 'why?', criteria: ['damaged', 'late'] },
    fraud_signal: { type: 'noul', instructions: 'fraud?', assertAt: 0.1, refuteAt: 0.9 },
  } } } }));
  const r = await run(['admit', dir]);
  assert.equal(r.code, 1, `JA3: certified with a refused battery:\n${r.text}`);
});
