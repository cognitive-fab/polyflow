// Step 4b — the enforcement point.
//
// The claim polyflow can make today is that an admitted workflow will never
// ORDER an unverified push. That is true, and it is not the sentence a reader
// hears: a confused or injected agent can still call `Bash: git push` outside
// the workflow, because the machine is a checked ADVISOR to an unchecked
// EXECUTOR.
//
// These tests are about closing that gap, and the decisive one is the fourth:
// the same weakened workflow step 0 uses, run for real, with the push DENIED
// rather than merely un-ordered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Polyflow, makeTools } from '../src/index.mjs';
import { decide, looksLike, matchable, argvOf, ALLOW, DENY } from '../src/match.mjs';
import { polyflowGate, unenforceable, openKinds, guardsOf } from '../adapters/claude-code/gate.mjs';
import { read, costOf, journalPath } from '../src/decisions.mjs';

// Vendored from cognitive-fab/polyness `proposals/verified-push` — the step 0
// artifact, which is the workflow this gate exists to make binding.
const PROPOSAL = resolve(import.meta.dirname, 'fixtures', 'verified-push');
// Only `push` is gated. Gating is opt-in per effect precisely so a workflow's
// other invariants — `at-most-one-verify-per-run` is about the workflow's own
// emissions — do not turn into a reason to stop somebody running their tests.
const MATCH = { push: { argv: ['git', 'push'] } };

/** A library holding just verified-push, with `match` added to its tools. */
function library(t, patch) {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-gate-'));
  const to = join(dir, 'workflows', 'verified-push');
  cpSync(PROPOSAL, to, { recursive: true });

  const dfile = join(to, 'polyflow.workflow.json');
  const d = JSON.parse(readFileSync(dfile, 'utf-8'));
  for (const [kind, match] of Object.entries(MATCH)) if (d.tools[kind]) d.tools[kind].match = match;
  writeFileSync(dfile, JSON.stringify(d, null, 2), 'utf-8');

  patch?.(to);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ } });
  return { dir, workflows: join(dir, 'workflows') };
}

async function engine(t, workflows, dbPath) {
  const pf = new Polyflow({ workflowsDir: workflows, dbPath, agent: 'gate', instance: 'g', pollMs: 20 });
  await pf.start();
  t.after(() => pf.close());
  const tools = makeTools(pf);
  return { pf, mcp: (n, a) => tools.find((x) => x.name === n).handler(a) };
}

/** What the hook receives. */
const call = (command) => ({ tool_name: 'Bash', tool_input: { command } });
/** What `decide`/`looksLike` take — the same call, already destructured. */
const bash = (command) => ({ tool: 'Bash', input: { command } });

test('a command is matched by an argv PREFIX, not by equality or a substring', () => {
  // A loose match is a hole; a strict one jams the first time an argument
  // changes. The prefix is the only shape that survives both.
  const spec = { tool: 'Bash', match: { argv: ['git', 'push'] } };
  assert.equal(looksLike(spec, bash('git push origin main')), true);
  assert.equal(looksLike(spec, bash('git push --force-with-lease origin main')), true);
  assert.equal(looksLike(spec, bash('cd /repo && git push origin main')), true);
  assert.equal(looksLike(spec, bash('git status')), false);
  assert.equal(looksLike(spec, bash('echo "git push" >> notes.md')), false);
  // Another tool with the same words is not this effect.
  assert.equal(looksLike(spec, { tool: 'Write', input: { content: 'git push' } }), false);
  assert.deepEqual(argvOf('cd api && FOO=1 git push origin main'), ['git', 'push', 'origin', 'main']);
});

test('a rule name is read anchored, not as a substring', () => {
  // `no-push-without-a-passing-verify` contains the word "verify". Reading it
  // as a rule about the `verify` effect made the gate offer to block a user
  // running their own tests — which is how a gate gets switched off, and a
  // gate that is off guards nothing at all.
  assert.equal(guardsOf('no-push-without-a-passing-verify'), 'push');
  assert.equal(guardsOf('at-most-one-verify-per-run'), 'verify');
  assert.equal(guardsOf('at-most-one-push-per-run'), 'push');
  assert.equal(guardsOf('commit-implies-a-prior-stage'), 'commit');
  assert.equal(guardsOf('exactly-one-verify-per-push-run'), 'push');
  assert.equal(guardsOf('something-else-entirely'), null);
});

test('an effect the gate cannot recognise is refused at admission', () => {
  // The gate and the certificate police each other. A workflow admitted with a
  // promise nothing can keep is worse than one with no promise, because it
  // reads exactly like one that is kept.
  const wf = { tools: { push: { tool: 'Bash' }, stage: { tool: 'Bash', match: { argv: ['git', 'add'] } } } };
  assert.deepEqual(unenforceable(wf, ['no-push-without-a-passing-verify']), ['push']);
  assert.deepEqual(unenforceable(wf, ['at-most-one-stage-per-run']), []);
  assert.equal(matchable({ tool: 'Bash' }), false);
  assert.equal(matchable({ tool: 'Bash', match: { argv: [] } }), false);
  assert.equal(matchable({ tool: 'Bash', match: { argv: ['git', 'push'] } }), true);
});

test('the default is allow, and only a guarded effect is ever denied', async (t) => {
  const { dir, workflows } = library(t);
  const { pf } = await engine(t, workflows, join(dir, 'a.sqlite'));
  const gate = polyflowGate(pf, { root: dir });

  // `push` is named by an invariant; `stage` and `commit` are not.
  assert.deepEqual([...gate.guarded.keys()], ['push']);

  assert.equal((await gate.evaluate(call('ls -la'))).decision, ALLOW);
  assert.equal((await gate.evaluate(call('npm test'))).decision, ALLOW);
  assert.equal((await gate.evaluate(call('git add -A'))).decision, ALLOW);
  assert.equal((await gate.evaluate(call('git commit -m x'))).decision, ALLOW);
  // …and the guarded one, with no run waiting for it.
  const v = await gate.evaluate(call('git push origin main'));
  assert.equal(v.decision, DENY);
  assert.match(v.reason, /no run of it is waiting/);
  assert.match(v.reason, /workflow_start verified-push/);
});

test('an open order is what makes the guarded step allowed', async (t) => {
  const { dir, workflows } = library(t);
  const { pf, mcp } = await engine(t, workflows, join(dir, 'b.sqlite'));
  const gate = polyflowGate(pf, { root: dir });

  let v = await mcp('workflow_start', { workflow: 'verified-push', input: { branch: 'main' } });
  // The run is in `verifying`: a push is not what it is waiting for.
  assert.equal((await gate.evaluate(call('git push origin main'))).decision, DENY);

  for (const _ of ['verify', 'stage', 'commit']) {
    v = await mcp('workflow_report', { order_id: v.next[0].order_id, result: {} });
  }
  assert.equal(v.state.phase, 'pushing');
  assert.deepEqual([...await openKinds(pf)], ['push']);
  const allowed = await gate.evaluate(call('git push origin main'));
  assert.equal(allowed.decision, ALLOW);
  assert.match(allowed.reason, /an open order awaits this/);
});

test('a failed verification blocks the run, and the push is then DENIED at the tool', async (t) => {
  // THE ONE THAT MATTERS. Step 0 proves the run is never OFFERED a push after
  // a failed verification. This proves the agent cannot take one anyway — the
  // difference between "the workflow will not order an unverified push" and
  // "an unverified push cannot happen".
  const { dir, workflows } = library(t);
  const { pf, mcp } = await engine(t, workflows, join(dir, 'w.sqlite'));
  const gate = polyflowGate(pf, { root: dir });

  const started = await mcp('workflow_start', { workflow: 'verified-push', input: { branch: 'main' } });
  const blocked = await mcp('workflow_report', {
    order_id: started.next[0].order_id, ok: false, permanent: true, error: 'tests-failed',
  });
  assert.equal(blocked.state.phase, 'blocked');
  assert.deepEqual(blocked.next ?? [], [], 'nothing further is offered');

  // …and the agent reaching for the tool directly is refused.
  const v = await gate.evaluate(call('git push origin main'));
  assert.equal(v.decision, DENY);
  assert.match(v.reason, /no run of it is waiting for this step/);

  // The refusal is in the journal, naming the rule that caused it.
  const denial = read(dir).find((e) => e.decision === 'deny');
  // BOTH rules that constrain `push` are named, because the user is owed the
  // whole reason rather than the first one that happened to match.
  assert.deepEqual(denial.rules.sort(),
    ['at-most-one-push-per-run', 'no-push-without-a-passing-verify']);
  assert.equal(denial.arg, 'git push origin main');
});

test('a workflow refused at admission guards nothing, and says so plainly', async (t) => {
  // Worth stating rather than implying: a REFUSED workflow is not a gated one.
  // polyflow declines to make the promise, so the tool is exactly as open as
  // it was before polyflow existed. The protection here comes from the gate
  // refusing the workflow, not from the enforcement point.
  const { dir, workflows } = library(t, (to) => {
    const file = join(to, 'machine.cjs');
    const src = readFileSync(file, 'utf-8');
    const before = "        next.phase = 'blocked';\n"
      + "        next.reason = String(proposal.reason || 'tests-failed');\n"
      + "        unchanged('verified');";
    const after = "        next.phase = 'staging';\n"
      + "        next.reason = String(proposal.reason || 'tests-failed');\n"
      + "        unchanged('verified');";
    assert.ok(src.includes(before), 'the acceptor to weaken was not found');
    writeFileSync(file, src.replace(before, after), 'utf-8');
  });

  const { pf } = await engine(t, workflows, join(dir, 'c.sqlite'));
  // Refused at admission, exactly as step 0 says.
  assert.equal(pf.admitted('verified-push'), false);

  // And with nothing admitted there is no open order for anything, so the
  // agent reaching for the tool directly is refused by the gate too — for the
  // plainer reason that no run is waiting for it.
  const gate = polyflowGate(pf, { root: dir });
  assert.deepEqual([...gate.guarded.keys()], [], 'a refused workflow contributes no guard');
  const v = await gate.evaluate(call('git push origin main'));
  assert.equal(v.decision, ALLOW, 'and the tool is as open as it was before');
});

test('an unreachable order book denies a guarded push and still allows ls', () => {
  // The decision settled in the build plan, as a test rather than a comment.
  // Globally fail-closed bricks the shell; globally fail-open evaporates the
  // guarantee exactly when things are broken.
  const guarded = new Map([['push', {
    spec: { tool: 'Bash', match: { argv: ['git', 'push'] } },
    workflow: 'verified-push', rules: ['no-push-without-a-passing-verify'],
  }]]);
  const book = { guarded, unreachable: true };
  assert.equal(decide({ tool: 'Bash', input: { command: 'ls -la' } }, book).decision, ALLOW);
  const denied = decide({ tool: 'Bash', input: { command: 'git push origin main' } }, book);
  assert.equal(denied.decision, DENY);
  assert.match(denied.reason, /order book is unreachable/);
});

test('every decision is journalled, and an override is a labelled false positive', async (t) => {
  // §4.8. Every other harness records what the agent DID. None record what it
  // tried and was stopped from doing, because none make checkable denials —
  // and a denial the user overrides is the only observation in the system that
  // can tell a rule it is wrong.
  const { dir, workflows } = library(t);
  const { pf } = await engine(t, workflows, join(dir, 'd.sqlite'));
  const gate = polyflowGate(pf, { root: dir });

  await gate.evaluate(call('ls -la'));
  await gate.evaluate(call('git push origin main'));

  const entries = read(dir);
  assert.equal(entries.length, 2);
  const denial = entries.find((e) => e.decision === 'deny');
  assert.equal(denial.kind, 'push');
  assert.equal(denial.workflow, 'verified-push');
  assert.deepEqual(denial.rules.sort(),
    ['at-most-one-push-per-run', 'no-push-without-a-passing-verify']);
  assert.equal(denial.arg, 'git push origin main');

  const { override } = await import('../src/decisions.mjs');
  override(dir, { kind: 'push', note: 'hotfix, tests were run in CI' });
  const cost = costOf(read(dir), 'no-push-without-a-passing-verify');
  assert.equal(cost.denied, 1);
  assert.equal(cost.overridden, 0, 'the override is its own entry, not an edit of the denial');
  assert.match(journalPath(dir), /\.polyness[/\\]decisions\.jsonl$/);
});

test('a key in a denied command does not reach the journal', async (t) => {
  // §7 applies to the gate's own log in full. A denied command is still a
  // command somebody typed.
  const { dir, workflows } = library(t);
  const { pf } = await engine(t, workflows, join(dir, 'e.sqlite'));
  const gate = polyflowGate(pf, { root: dir });

  const key = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG';
  await gate.evaluate(call(`ANTHROPIC_API_KEY=${key} git push origin main`));
  const text = readFileSync(journalPath(dir), 'utf-8');
  assert.equal(text.includes('sk-ant'), false);
  assert.match(text, /\[redacted\]/);
});

test('a gate that cannot write its journal still decides', async (t) => {
  // Enforcement never waits on logging. A full disk may not become a way to
  // get an unverified push through, and may not stop all work either.
  const { dir, workflows } = library(t);
  const { pf } = await engine(t, workflows, join(dir, 'f.sqlite'));
  const gate = polyflowGate(pf, { root: ' nowhere' });
  const v = await gate.evaluate(call('git push origin main'));
  assert.equal(v.decision, DENY);
});
