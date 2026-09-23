// P9 review — admission (the WT structural checks, and the module rule the
// P9 security Response relies on). Each test fails today for the reason in its
// message. See docs/platform/reviews/P9-review.md.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admit } from '../src/admit.mjs';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function copy(name = 'customer-brief') {
  const dir = mkdtempSync(join(EXAMPLES, '.tmp-review-p9-'));
  cpSync(join(EXAMPLES, name), dir, { recursive: true });
  made.push(dir);
  return dir;
}
const edit = (file, from, to) => {
  const src = readFileSync(file, 'utf-8');
  assert.ok(src.includes(from), `fixture drift: '${from}' not found in ${file}`);
  writeFileSync(file, src.replace(from, to));
};
const item = (r, name) => r.checks.flatMap((c) => c.items ?? []).find((i) => i.name === name);

test('WT1: a wait whose FAILURE completion the state refuses has no exit on failure, and is not certified', async () => {
  // posting orders post_brief; its onSuccess is POST_DONE and its onFailure /
  // onExhausted is POST_FAILED. Make `posting` refuse POST_FAILED: a post that
  // fails leaves the run in `posting` for ever — and `posting` is declared
  // unstoppable, so nobody can end it. The check asks whether SOME incoming
  // stimulus is accepted, and POST_DONE is.
  const dir = copy();
  edit(join(dir, 'machine.cjs'),
    'POST_FAILED: (model) => (proposal, { reject, next, unchanged }) => {',
    "POST_FAILED: (model) => (proposal, { reject, next, unchanged }) => { if (model.briefState === 'posting') return reject('post-failures-are-not-handled');");
  const r = await admit(dir);
  const wait = item(r, 'every-wait-has-an-exit');
  assert.equal(r.ok, false, `WT1: certified (every-wait-has-an-exit: ${JSON.stringify(wait)}): a failed post strands an unstoppable run in 'posting'; the check needs one accepted completion per ORDER OUTCOME, not one per state`);
});

test('DEP1: a package required through a template literal is refused, like the same require in quotes (P9 security Response, SEC-CT1)', async () => {
  // SEC-CT1's fix accepts `require(\`...\`)` as a literal; the DEP rule
  // (admit.mjs moduleProblems) only matches quotes. The Response says package
  // requires other than sam-pattern "were already refused at admission".
  const dir = copy();
  edit(join(dir, 'effects.cjs'), "'use strict';", "'use strict';\nconst _path = require(`node:path`);");
  const r = await admit(dir);
  assert.equal(r.ok, false, `DEP1: certified with require(\`node:path\`) in effects.cjs (problems: ${JSON.stringify(r.problems)})`);
});

test('DEP2: a package required with a space before the parenthesis is refused', async () => {
  const dir = copy();
  edit(join(dir, 'effects.cjs'), "'use strict';", "'use strict';\nconst _path = require ('node:path');");
  const r = await admit(dir);
  assert.equal(r.ok, false, `DEP2: certified with require ('node:path') in effects.cjs (problems: ${JSON.stringify(r.problems)}): moduleProblems matches /require\\(/ and certificates.mjs matches /require\\s*\\(/`);
});

test('DEP0: the positive control — the same require in quotes is refused', async () => {
  const dir = copy();
  edit(join(dir, 'effects.cjs'), "'use strict';", "'use strict';\nconst _path = require('node:path');");
  const r = await admit(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /requires 'node:path'/);
});
