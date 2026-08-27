// A library is refused, not repaired.
//
// Both of these are silent-wrong-answer bugs rather than crashes, which is why
// they are worth refusing at load: one hands the agent a work order naming
// another workflow's tool, the other advertises a workflow under a name that
// cannot be started. Neither raises anything at the point it goes wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Polyflow, Library } from '../src/index.mjs';

const WORKFLOWS = resolve(import.meta.dirname, '..', 'workflows');
const DESCRIPTOR = 'polyflow.workflow.json';

/** A throwaway library built by copying the demo workflow under new names. */
function library(t, edits) {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-lib-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ } });
  for (const [name, edit] of Object.entries(edits)) {
    const to = join(dir, name);
    cpSync(join(WORKFLOWS, 'customer-brief'), to, { recursive: true });
    const d = JSON.parse(readFileSync(join(to, DESCRIPTOR), 'utf-8'));
    writeFileSync(join(to, DESCRIPTOR), JSON.stringify(edit({ ...d, name }), null, 2), 'utf-8');
  }
  return dir;
}

test('two workflows declaring one effect differently are refused', async (t) => {
  // polyrun keys handlers by effect kind across the whole runtime, so the
  // later workflow would overwrite the earlier one and runs of the first would
  // hand the agent work orders naming the second's tool — with no error.
  const dir = library(t, {
    'brief-a': (d) => d,
    'brief-b': (d) => ({ ...d, tools: { ...d.tools, draft_brief: { tool: 'some_other_llm', why: 'draft it' } } }),
  });

  const pf = new Polyflow({ workflowsDir: dir, dbPath: join(dir, 'x.sqlite'), pollMs: 20 });
  await assert.rejects(() => pf.start(), /effect 'draft_brief' is declared differently/);
});

test('two workflows sharing an effect identically are fine', async (t) => {
  const dir = library(t, { 'brief-a': (d) => d, 'brief-b': (d) => d });
  const pf = new Polyflow({ workflowsDir: dir, dbPath: join(dir, 'y.sqlite'), pollMs: 20 });
  t.after(() => pf.close());
  await pf.start();
  assert.deepEqual([...pf.library.workflows.keys()].sort(), ['brief-a', 'brief-b'],
    'the refusal is about disagreement, not about sharing');
});

test('a workflow whose descriptor disagrees with its directory is refused', (t) => {
  // list() advertises the descriptor name and get() looks up the directory:
  // let them differ and the agent is offered a workflow it cannot start.
  const dir = library(t, { 'brief-a': (d) => ({ ...d, name: 'something-else' }) });
  assert.throws(() => new Library(dir).load(),
    /workflow in 'brief-a\/' calls itself 'something-else'/);
});

test('specs differing only in a field this code does not know about are still refused', async (t) => {
  // Descriptors are carried through unvalidated, so the guard cannot be a list
  // of the three fields that happen to exist today: the moment a spec grows a
  // fourth, a partial compare calls two different specs identical and hands
  // runs of one workflow the other's work orders.
  const dir = library(t, {
    'brief-a': (d) => d,
    'brief-b': (d) => ({
      ...d,
      tools: { ...d.tools, draft_brief: { ...d.tools.draft_brief, role: 'reviewer' } },
    }),
  });
  const pf = new Polyflow({ workflowsDir: dir, dbPath: join(dir, 'z.sqlite'), pollMs: 20 });
  await assert.rejects(() => pf.start(), /effect 'draft_brief' is declared differently/);
});

test('the same spec written in a different key order is the same spec', async (t) => {
  const dir = library(t, {
    'brief-a': (d) => ({
      ...d,
      tools: { ...d.tools, draft_brief: { tool: 'ask', why: 'draft the brief from the gathered tickets' } },
    }),
    'brief-b': (d) => ({
      ...d,
      tools: { ...d.tools, draft_brief: { why: 'draft the brief from the gathered tickets', tool: 'ask' } },
    }),
  });
  const pf = new Polyflow({ workflowsDir: dir, dbPath: join(dir, 'w.sqlite'), pollMs: 20 });
  t.after(() => pf.close());
  await pf.start();
  assert.equal(pf.library.workflows.size, 2, 'key order is not a difference');
});
