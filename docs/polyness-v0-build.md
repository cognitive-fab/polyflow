# polyness v0 — build plan

How the steps in [`polyness-v0-plan.md`](polyness-v0-plan.md) get written.
The plan says what each step must prove; this says what files exist, what they
export, and what has to be settled before any of it is typed.
Spec: [`polyness-spec.md`](polyness-spec.md).

---

## Settle these before writing code

**1. Re-baseline the corpus. — SETTLED, done.** `scripts/baseline.mjs` exists
and `test/baseline.json` is its committed output. Tests assert against that file,
never against numbers in prose: a figure in a document drifts silently, a figure
in a fixture drifts loudly.

Measured 2026-08-27, against the spec's *414 sessions · 53 projects · 647 MB ·
28,382 calls*:

| | spec | measured |
|---|---|---|
| sessions | 414 | **165** |
| projects with tool calls | 32 | **35** |
| tool calls | 28,382 | **29,584** |
| size | 647 MB | **535 MB** |
| pushes (from `gitOperation`) | — | **358** |
| commits (from `gitOperation`) | — | **183** |

Read that carefully, because the two halves say different things. **Tool calls
and projects are intact and slightly grown** — so §1.1's per-project analysis,
which is the measurement the design rests on, should reproduce. **Sessions have
more than halved** — transcripts have been pruned or rotated, and the survivors
carry nearly all the calls. So any claim keyed on a session count is stale, and
any claim keyed on projects or calls is not.

Also measured: **10 unparsable lines** across the corpus (truncated writes — the
reader skips them rather than failing a project), and **0 sidechain records**.

**2. The polygen key. — ANSWERED, and it produced a constraint on step 5.**
Run 2026-08-27 against `proposals/verified-push/contract.json`, `--model opus-5`.

The first run **did not converge.** The repair loop oscillated for its whole
budget between two failures:

| iteration | failure |
|---|---|
| 0 | violates `a-failed-verification-ends-the-run-in-blocked` |
| 1 | `step threw on VERIFY_FAILED` — reject() after next-state writes |
| 2 | the invariant again |
| 3 | the throw again |

The authored module's own header named the mistaken belief: the rejection label
*"is emitted AFTER the next-state writes that move the run to `blocked`"*. The
model had concluded that `VERIFY_FAILED` in `verifying` was simultaneously an
accepted transition and a labelled rejection. Fix one side, break the other.

**The cause was the contract, not polygen.** `specialRules` named
`VERIFY_FAILED` twice — once as "goes straight to blocked", once under
`stale-completions-reject` whose `whenState` was the prose string *"any
non-awaiting state"*. Nothing declared the branches disjoint and nothing stated
the SAM rule that a declined branch must reject *before* writing.

A second run changed **only the `specialRules`** — same states, actions, domains
— adding an explicit `accepted-and-declined-are-disjoint` rule, replacing prose
`whenState` values with named states, and saying outright that `VERIFY_FAILED`
in `verifying` is accepted rather than a labelled rejection. It **converged on
iteration 0**: 8 states, 148 corpus windows, 0 replay fails.

The authored machine was then dropped into the proposal in place of the
hand-written one, with **polyness's mined `effect-invariants.mjs` untouched**:

```
PASS  admitted by the gate
      paths explored: 5 · states seen: 8 · exhaustive within declared domains
PASS  failed verify → blocked · run is done · nothing further offered
PASS  no push order was ever issued   $create → START → VERIFY_FAILED
PASS  happy path reaches staging → committing → pushing → pushed
```

Same certificate as the hand-written machine — 5 paths, 8 states, exhaustive.
**The propose path is viable end to end, with generated code.** Step 0's last
open leg is closed.

Two things follow. **Step 5 inherits a hard requirement** (below), and the key
question is now only operational: polygen needs a working opus-5 key at the time
step 5 runs, and a 3-hour key does not settle that.

**3. Fail-open or fail-closed at the gate. — SETTLED.** Neither globally. The
gate fails **closed** only for effect kinds named in an admitted invariant of a
running instance, and **open** for everything else. When the order book is
unreachable, a globally fail-closed gate bricks the shell and a globally
fail-open one evaporates the guarantee exactly when things are broken; scoping
it this way makes the blast radius equal to the promise, and a polyflow outage
cannot stop a user running `ls`.

The corollary is a test, not a comment: **an unreachable order book must deny a
guarded push and allow an unguarded `ls`, in the same run.**

---

## What the corpus actually gives you

Measured, not assumed. Four of these change the code.

| finding | consequence |
|---|---|
| **`toolUseResult.gitOperation`** is present and structured — `{"push":{"branch":"main"}}` (235×), `{"commit":{"sha":"…","kind":"committed","branch":"…"}}` | Push and commit detection needs **no regex**. §1.3's classifier anxiety narrows to verification detection alone. `push.branch` is also the run key `polyflow.workflow.json` templates on. |
| **`gitBranch`** and **`cwd`** on every record | §4.2's "repo state is always absent in v0" is half wrong. Branch is there; `head` and `dirty` are not. |
| **`isSidechain` is 0** corpus-wide | No subagent attribution needed in v0. Keep the field check anyway — it costs one line and its absence is not guaranteed. |
| **no exit codes.** `returnCodeInterpretation` exists but is search-tool prose ("No matches found", 158×) | §4.2.2 stands. Outcome really is soft, and corrections-before-conclusions is the right order. |
| `type: 'user'` covers **both prompts and tool results** | Episode splitting needs a real discriminator, not a type check. See step 1. |
| `system` records carry `hookCount`, `hookInfos`, `preventedContinuation` | A thread to pull for §4.8 — there may be more hook telemetry recoverable than §6 assumes. Not v0. |

---

## Module map at the end of v0

```
polyness/
  bin/polyness.mjs          audit · replay · propose · watch      ← package.json already declares this
  src/
    reader.mjs              streamed JSONL → raw records
    normalise.mjs           raw → the §4.2 record; the alphabet
    episodes.mjs            episode boundaries and the intent text
    corrections.mjs         per-project store; outcome classification
    cache.mjs               node:sqlite, keyed on journal mtime
    subjects.mjs            consequential kinds with ≥ floor instances
    rules.mjs               the four patterns → predicates
    provenance.mjs          own · borrowed · neither, and mined_at
    replay.mjs              score a rule against the corpus
    audit.mjs               the report, --show, staleness
    propose.mjs             write the proposal directory
    thresholds.mjs          every constant in §4.4 / §4.4.1, in one object
  scripts/baseline.mjs
  test/
    fixtures/mini.jsonl     hand-built, ~40 lines, every edge case named below
    baseline.json           committed output of scripts/baseline.mjs
    step0.test.mjs … step4b.test.mjs
```

`thresholds.mjs` exists so the plan's "step 3's thresholds are guesses" risk is a
parameter rather than a grep. Nothing else may hardcode 5, 60, 40, 90 or 3.

---

## Step 1 — reader and normaliser

**Exports**

```js
// reader.mjs
export function projects(root = defaultRoot())        // [{ project, dir, files }]
export async function* raw(jsonlPath)                 // parsed lines, streamed

// normalise.mjs
export function normalise(line, ctx)                  // → Record | null
export function alphabet(command)                     // 'cd api && npm test -- --watch' → 'npm test'

// episodes.mjs
export function isPrompt(line)                        // the discriminator, tested directly
export async function* episodes(recordStream)         // assigns .episode, drops runs < 3 calls
```

**The record.** §4.2 plus two fields the corpus justifies:

```js
{ at, project, session, episode, kind, tool, arg, outcome, files,
  branch,            // from gitBranch
  git }              // from toolUseResult.gitOperation, when present
```

**Two rules that decide correctness.**

`gitOperation` **wins over the regex** when both are present. It is first-party
structured data; the alphabet is a heuristic over command text. The alphabet
still runs for everything else.

A prompt is a `user` record whose `message.content` is a **string**, with
`isMeta` falsy. A tool result is a `user` record whose content is an **array**
containing a `tool_result`. Pin `isPrompt` in its own test — getting this wrong
silently halves the episode count and every downstream number with it.

**Fixture must contain:** a prompt; a `cd x && npm test` Bash pair; a push with
`gitOperation`; a commit with `gitOperation`; an `isMeta` record; a two-call run
that must be dropped; a record with `is_error`.

**Done when** the fixture produces exactly the expected records, and a run over
the real corpus matches `test/baseline.json`.

---

## Step 2 — corrections

**Exports**

```js
// corrections.mjs
export function load(projectDir)                      // → Corrections
export function save(projectDir, corrections)
export function classify(record, corrections)         // 'passed'|'failed'|'errored'|'unknown'
```

Because push and commit now come from `gitOperation`, corrections have exactly
one job: **what counts as a verification in this project.** That is a much
smaller surface than the spec anticipated and makes the step easier.

`errored` when `is_error` is set. Otherwise match the result text against the
project's verification patterns for `passed`/`failed`. Otherwise `unknown`, and
`unknown` is never counted as either.

**Done when** correcting a project's verification command changes its numbers,
the change survives a re-run, and an unclassifiable project reports `unknown`.

---

## Step 3 — subjects, rules, provenance

**Exports**

```js
// subjects.mjs
export const CONSEQUENTIAL                            // git push, git commit, git tag, npm publish, …
export function subjects(records, thresholds)         // → [{ kind, instances, episodes }]

// rules.mjs
export const PATTERNS                                 // the four, as data
export function synthesise(subject, records, thresholds)   // → [Rule]

// provenance.mjs
export function classify(rule, thisProject, otherProjects, thresholds)  // 'own'|'borrowed'|'neither'
```

```js
// Rule
{ name, pattern, subject, guard,
  support:   { holds, of },
  minedAt:   '2026-08-27',
  provenance:'own',
  // emitted verbatim into effect-invariants.mjs:
  predicate: "(path) => path.count('push') <= 1" }
```

Write `PATTERNS` as a **table**, not four code paths. Each entry names the rule,
tests the instances, and emits predicate source. The generated
`effect-invariants.mjs` is then a render of that table, which is what makes step 5
mechanical.

**Done when** it reproduces the re-baselined §1.2 table **and proposes no rule**
for the project with 7 pushes and 1 verification run. The refusal is the test.

---

## Step 3.5 — `polyness replay`

**Exports**

```js
// replay.mjs
export function replay(rule, records)
// → { instances, holds, wouldBlock: [recordIds], blockedThenSucceeded, minedAt, driftedSince }
```

Pure function over records and a rule. No new mining, no new reading — it is a
CLI surface over what steps 1–3 already produce.

`wouldBlock` lists the instances the rule refuses. `blockedThenSucceeded` counts
those that nonetheless completed cleanly — the false-positive proxy, and the only
honest cost estimate available before enforcement exists. After step 4b, the
decision journal (§4.8) supplies the real one.

**Done when** it scores a rule the tool did not mine, refuses to propose one
below the floor, and is demonstrated on a rule that **passes on one project and
fails on another from the same corpus.** A scorer that only ever agrees with the
miner has not been tested.

---

## Step 4 — `polyness audit`

`bin/polyness.mjs` is declared in `package.json` and does not exist. It gets
created here, with subcommands dispatching to `audit.mjs`, `replay.mjs`,
`propose.mjs`.

Per-project output ranked by regret. `--show <finding>` traces every printed
number to project, session, timestamp and command. `--correct` from step 2.
`--export` emits counts and shapes only, per §7. Stale-rule reporting for
admitted workflows whose support has decayed below the floor since `minedAt`.

**Done when** every number traces in one command, and a below-floor project says
"not enough history yet" and proposes nothing.

---

## Step 5 — `polyness propose`, and the contract emitter's one hard rule

Measured above, not guessed: **`specialRules` must partition accepted and
declined branches explicitly, or polygen's repair loop oscillates and never
converges.** The emitter therefore always writes, in this order:

1. A standing `accepted-and-declined-are-disjoint` rule stating the SAM
   constraint in words: a declined branch calls `reject(reason)` and returns
   **before** writing any next-state field; an accepted branch writes and never
   rejects; there is no accept-with-reason. A transition into a terminal
   *failure* state is an accepted transition, not a rejection — this is the
   sentence the first run got wrong.
2. One rule per accepted transition, with `whenState` naming **actual states**,
   never prose like "any non-awaiting state".
3. One rule per declined family, listing the awaiting state for each action so
   "every other state" is computable rather than interpreted.

A contract that names the same action in two rules without saying which branch
is which is the failure mode, and it is the emitter's job to make that
unrepresentable. Fixture for the regression: the two contracts from the
2026-08-27 run — the one that oscillated and the one that converged differ in
`specialRules` alone.

## Step 4b — enforcement point (polyflow)

**Do not start from scratch.** `~/code/polysec/examples/polysec-agent-gate/`
already has this shape working: `gate.mjs` (command transport), `hook.mjs`
(in-process SDK callback), `session.mjs` (the decision logic), signed session
receipts, and `settings.gate.json`. With measurements: the command hook costs
~940 ms per tool call, of which ~830 ms is bare node startup; the in-process
decision is 17.7 µs. **Take the in-process shape** — that difference is whether a
user leaves it on.

It also records the fact the entire claim rests on: hooks run first in the
six-step permission pipeline, and **a hook deny holds even under
`bypassPermissions`.**

**New in polyflow**

```
adapters/claude-code/gate.mjs      transport, forked from polysec's
adapters/claude-code/hook.mjs      in-process variant
src/match.mjs                      the correspondence contract
src/decisions.mjs                  the §4.8 journal
```

```js
// match.mjs
export function decide({ tool_name, tool_input, cwd, session_id }, orderBook)
// → { decision: 'allow'|'deny', reason, rule?, kind? }
```

**The correspondence contract.** The descriptor's `tools` block gains `match`:

```json
"push": { "tool": "Bash", "match": { "argv": ["git", "push"] }, "why": "…" }
```

Default is **allow**. Deny only when the call matches a guarded effect kind of a
*running* instance with no open order for it. A workflow asserting an invariant
over an effect whose `match` cannot be evaluated is **refused admission** — the
gate and the enforcement point police each other.

**Done when** step 0's weakened `verified-push`, run for real, has its push
denied after a failed verification; an unrecognisable `match` is refused at
admission; and a denial the user overrides appears in the journal as an
overridden denial, visible to `replay`.

---

## Sequencing

1 → 2 → 3 → 3.5 → 4 are strictly sequential, one commit each with its test.

**4b depends only on step 0** and can move earlier if the "did stop" claim is
wanted sooner. It sits after 4 because a mined proposal demos better than a
hand-written one, and because the decision journal is worth more once there are
rules worth overriding.

5 and 6 follow the plan unchanged, 5 gated on the key question above.

---

## Risks carried forward

**Correspondence is the hard part of 4b**, not the plumbing. A loose match is a
hole; a strict one jams the first time an argument changes. Everything the
adapter claims rests on it.

**Thresholds are still set from one corpus** and their test still pins them to
that corpus. `thresholds.mjs` makes them changeable; it does not make them right.
Revisit on the first machine that is not this one.

**Replay's false-positive proxy is a proxy.** `blockedThenSucceeded` is inferred
from history, not observed. Only the decision journal produces the real number,
and only after someone has been denied something they wanted.
