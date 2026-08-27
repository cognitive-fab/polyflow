# polyness — specification, v0

**Find the work you already repeat, and run it as a checked workflow.**

polyness reads the journals an agent already writes, finds the shapes that recur,
proposes each one as a polyflow workflow with the rules its own history implies,
and — once a workflow is admitted — notices when you are about to do it again and
offers to run it properly.

It is the induction half of polyflow. polyflow's README has carried the promise
for a while:

> **Promotion.** Workflows are hand-authored here. The plan is to mine recurring
> run shapes out of journals and propose a machine for review — induction from
> history, not foresight.

This is the specification for the first version of that.

---

## 1. Why now

A measurement over this machine's own Claude Code transcripts — 414 sessions
across 53 projects, 647 MB — produced one usable finding.

| | |
|---|---|
| sessions containing a successful push or publish | 35 |
| such steps in total | **77** |
| with a passing test earlier in the session | 42 (55%) |
| **with none** | **35 (45%)** |

Two things follow. The first is that a corpus like this contains *very few*
promotable shapes: after normalising commands and keeping only sequences ending
in something irreversible, exactly one recurred across projects — commit, then
push. The second is that the rule worth attaching to that shape is not invented.
It is the rule the history already half-follows.

That is the whole product in one sentence: **the workflow to propose is the one
you already run, and the rule to enforce is the one you already break.**

### What the finding is not

The classifier is a regular expression over command text. A project that tests
through `make check`, a CI pipeline, or a language toolchain it does not
recognise reads as unverified when it was not. Session scope is arbitrary: a
test run in a previous session does not count. A push of a README is weighted
the same as a publish.

45% is a lead, not a result. §5.1 makes correcting it the user's first action
rather than a support ticket.

### 1.1 The same corpus, one project at a time

polyness runs per project, so the pooled number above is the wrong unit. Each of
the 53 journal directories was re-measured as its own corpus, which is what a
single user with a single repository actually has.

| | of 32 projects with tool calls |
|---|---|
| yield a recurring **shape** (same 3-4 step sequence, 3+ times) | **1 (3%)** |
| contain a push or publish at all | 15 |
| contain an **unverified** push | **7 (22%)** |

Even in the busiest band - projects with more than 1,500 tool calls - only 1 of 7
yielded a shape. Seventeen of the 32 projects have fewer than 200 calls and will
show nothing under any design.

This is the most important measurement in this document, and it changes the
design. **Sequence mining does not survive at the scale a real user has.** A push
happens ten or fourteen times in an active project, but the exact three-step
window around it differs every time, so requiring an identical normalised
sequence three times over is a filter almost nothing passes.

The rule never needed the sequence. "No push without a passing verification" is
answerable from the pushes alone. §4.4 is written accordingly: **rules are mined
over consequential events, not over shapes.** Seven projects in twenty-two
percent beats one in three.

### 1.2 What the pooled number was hiding

Splitting the ten projects that push regularly by whether they verify at all:

| pushes | verified | verification runs | project |
|---|---|---|---|
| 14 | **12** | 245 | kanjo |
| 11 | **11** | 82 | polycheck |
| 10 | **10** | 550 | polysec |
| 10 | **9** | 147 | polysim |
| 6 | **6** | 3 | sam |
| 3 | **3** | 281 | puffin |
| 7 | **0** | 1 | baanbaan-Merchant |
| 5 | **1** | 5 | cognitive-fab |
| 3 | **2** | 6 | hanuman-thai-cafe |
| 3 | **0** | 0 | glm |

Seven of the ten run verification five or more times. **Every one of those seven
verifies before pushing, almost always.** The 45% in §1 is concentrated in the
projects that barely test at all — where the finding is not "you forgot" but
"this project has no tests", which is a different sentence and not one a workflow
fixes.

This split is the difference between a tool that holds you to your own standard
and a linter with opinions. §4.4.1 makes it a rule of the design rather than an
observation about this corpus.

### 1.3 How much of this survived its own classifier

An earlier pass of the same measurement reported kanjo as 7 pushes, 0 verified.
It is 14 pushes, 12 verified. Nothing changed but the regular expression deciding
what counts as a verification — `make check` and `npm run <script>` were added.

One classifier change moved a headline finding from "this project never verifies"
to "this project nearly always does". That is the whole argument for building
`--show` and `--correct` (§3.1) before building anything that depends on the
number, and for `unknown` staying `unknown` (§4.2.2).

---

## 2. Goal, and what v0 is for

The goal is **identify repeatable workflows and run them as such in a given
situation.** Three verbs, in order:

1. **Audit** — show what you repeat and where the repetition already goes wrong.
2. **Propose** — turn a step you keep taking into a workflow with the rules your
   own history implies, and put it through polyflow's admission gate. A proposal
   that fails the gate is refused, not flagged.
3. **Recognise** — when a session starts doing something a workflow covers, say
   so and offer to start the run.

v0 ships all three, narrowly. Audit works on the journal that exists today with
nothing installed. Propose emits a candidate for one subject. Recognise suggests
and never acts.

The weight is not evenly spread, and §1.1 is why. Audit finds something in 22% of
projects; proposal follows from the same rules rather than from a second mining
pass. **Audit is the product. Propose and recognise are what it is for.**

### Out of scope for v0

- Authoring the state machine itself. polyness proposes the contract, the
  effect surface and the rules; **polygen** authors the machine and **polyflow's
  gate** decides whether it may run. polyness does not synthesise SAM modules.
- Harness generation of any kind. The scaffold an agent runs inside is a
  different layer and is not polyness's concern.
- Any journal but Claude Code's. The reader is an interface (§4.1) so a second
  source is additive, but v0 implements one.
- Cross-machine or hosted anything. Local files, local process. See §7.

---

## 3. Functional specification

### 3.1 `polyness audit`

Reads every journal it can find and reports what recurs, ranked by how often the
repetition is missing its own guard.

```
$ polyness audit

  code-kanjo · 8 sessions · 1,665 tool calls

  git push          7 times
    ⚠ 7 of 7 had no passing verification before them
      polyness audit --show git-push        the 7, with what came before each
      polyness audit --correct git-push     if that is wrong for this project

  git commit       23 times
    ✓ always preceded by a stage         23/23
    ✓ never twice in one episode         23/23

  1 step is worth proposing as a workflow.   polyness propose git-push
```

Run without a project it summarises every journal it can find, and reports the
per-project breakdown rather than a pooled number — a finding that only exists
when 53 projects are added together is not a finding a user can act on.

Below the support floor it says so and stops:

```
  code-cartograph · 2 sessions · 41 tool calls

  Not enough history yet. 1 push, and a rule needs at least 5 to mean
  anything. Come back after a few more sessions.
```

`--show <finding>` lists the underlying steps: project, session, timestamp, the
command, and what came before it. Every number the tool prints must be traceable
to specific journal records in one command. A user who cannot check a claim will
not believe the next one.

`--correct` teaches it: mark a listed step as a false positive and name the
project's real verification command. Corrections are stored per project (§4.5)
and every later number reflects them.

### 3.2 `polyness propose <subject>`

Turns a step you keep taking into a workflow proposal. The subject is the
consequential step; the steps around it are read off the majority path and are
there to name the thing, not to justify it.

```
$ polyness propose git-push

  From 14 pushes in this project. Lead-in taken from the 12 that share one.

  Steps          verify → stage → commit → push
  Rules          derived from your history, and how it would have gone:
                   no-push-without-a-passing-verify     you did this 12 of 14 times
                                                        would have stopped the other 2
                   at-most-one-push-per-run             never violated (14/14)
                   commit-implies-a-prior-stage         never violated (23/23)

  Written to     .polyness/proposals/verified-push/
                   contract.json          the states, actions and their domain
                   effect-invariants.mjs  the three rules above
                   polyflow.workflow.json the effect surface and run key
                   NOTES.md               which runs this came from

  The machine itself is not written. Next:
    polygen author .polyness/proposals/verified-push
    polyflow admit .polyness/proposals/verified-push
```

A rule is only proposed when the history supports it (§4.4). Each is printed with
its own counter-evidence, because a rule your own history violates half the time
is a decision, not a discovery — and the person reading has to make it.

Note what the first rule is made of. It is not a best practice and it is not this
tool's opinion: it is **your own twelve**. The proposal holds you to the standard
the majority of your own history already keeps, and the two it would have stopped
are the exception rather than the rule.

That is the whole stance, and it is why §4.4.1 exists:

> A proposal is not a description of what you do. It is what the rest of your
> history says you meant to.

The load-bearing words are *the rest of your history*. A rule with no support in
this project is not something you meant to do; it is something somebody else
thinks you should.

### 3.3 `polyness watch`

Recognition. Given what the current session has done so far, name the workflow
it matches and offer to run it.

```
$ polyness watch

  watching code-kanjo · 2 admitted workflows

  [14:22]  you are 2 steps into  verified-push
           next by that workflow:  run the verification
           start it properly:      workflow_start verified-push
```

v0 prints. It does not call `workflow_start`, does not block a command, and does
not modify a session. Turning a suggestion into an action is v1, and it needs
the richer journal (§6) before it deserves to be automatic.

---

## 4. Technical specification

### 4.1 Architecture

```
  ~/.claude/projects/**/*.jsonl
             │
             ▼
     Reader  ─────────────  one interface, one implementation in v0
             │              (streamed; a 54 MB transcript is not held in memory)
             ▼
   Normaliser ────────────  raw tool calls → an alphabet worth mining
             │
             ▼
     Episodes ────────────  a session is not a task; split on user prompts
             │
             ├──────────────▶  Miner ──▶ shapes ranked by regret
             │                              │
             │                              ▼
             │                        Rule synthesis
             │                              │
             │                              ▼
             │                        Proposal writer ──▶ polygen ──▶ polyflow gate
             ▼
        Recogniser ────────▶ "you are inside a workflow you already have"
```

Node, no build step, `node:sqlite` for the corrections and shape cache. The same
constraints as polyflow: nothing to install, nothing to configure.

### 4.2 The normalised record

Everything downstream reads this, and only this:

```js
{
  at:       1787802226170,        // ms
  project:  'code-kanjo',         // journal directory
  session:  '03318390-…',
  episode:  7,                    // §4.3
  kind:     'npm test',           // the alphabet — §4.2.1
  tool:     'Bash',               // what produced it
  arg:      'npm test -- --run',  // raw, truncated to 512 chars
  outcome:  'passed',             // passed | failed | errored | unknown
  files:    ['src/db.ts'],        // Edit/Write only
}
```

`repo: { head, branch, dirty }` is reserved and always absent in v0 — today's
journal has no state. §6 is how it arrives.

#### 4.2.1 The alphabet

Mining on tool names does not work. Measured: the top recurring shape across 19
projects was `Bash → Edit → Bash`, which is the generic agent loop and describes
nothing. `Bash` covers `npm test`, `git commit` and `gh pr create` alike, so the
signal is inside the argument.

A `Bash` call is normalised to the command it ran: leading `cd … &&` hops and
environment prefixes are stripped, and a known multi-word head (`git`, `npm`,
`gh`, `node`, `docker`, `cargo`, `go`, `pnpm`, `yarn`) keeps its subcommand.
`cd api && npm test -- --watch` becomes `npm test`. Every other tool contributes
its own name.

This single change turned an unusable result into the finding in §1.

#### 4.2.2 Outcome

`is_error` on a tool result is transport-level: it says the call failed, not that
the tests did. `npm test` exiting 1 and the Bash tool erroring are different
events and today they are indistinguishable, which is the main reason §1 is soft.

v0 classifies on a per-project basis: `errored` when `is_error` is set, otherwise
`passed`/`failed` by matching the result text against the project's known
verification patterns, otherwise `unknown`. **`unknown` is reported as unknown**
and never silently counted as either — a tool that guesses here produces exactly
the confident wrong number that loses the user.

### 4.3 Episodes

A session is not a task: one measured transcript held 5,863 records over two days.
An episode is the run of records between one user prompt and the next, which is
the only task boundary today's journal offers. Episodes shorter than three tool
calls are dropped.

The user's prompt text is retained as the episode's `intent`, unindexed in v0 —
it is what makes a proposal nameable, and it is what v1 needs to cluster shapes
by what they were *for* rather than by which commands they used.

### 4.4 Mining and rule synthesis

**The unit is a consequential event, not a sequence.** §1.1 measured why: an
identical 3-4 step window recurs in 3% of projects, while a consequential event
recurs in 47% and misbehaves in 22%. Mining sequences asks for a coincidence;
mining events asks only that the user has done the thing more than once.

A *subject* is a normalised kind in the consequential set - `git push`,
`git commit`, `git tag`, `npm publish`, `gh pr create`, `gh release`,
`docker push`, plus per-project additions - occurring at least **five times** in
the project. Below that the support is too thin for a rule to mean anything, and
the audit says "not enough history yet" rather than inventing a finding.

Consequence is the filter that makes this tractable. Everything recurs; only some
of it is worth a gate.

**Ranking is by regret**, not frequency: how often the subject occurred *without*
the guard its other instances had. A step that is always done correctly is not
worth a workflow. Verified-push ranks first because 45% of its instances skipped
verification.

**Shapes are still computed, but only for display.** Once a rule is worth
proposing, the majority path leading into the subject names the proposal and
gives it its steps. A subject whose lead-in never repeats simply yields a
proposal of one step and a rule, which is still a workflow worth admitting.

**Rules.** Candidates are drawn from a fixed vocabulary that maps one-to-one onto
polyflow's effect-invariant predicates — the same `path.count`, `path.emitted`,
`path.actionBefore` used by every hand-written workflow in the repo:

| pattern | proposed when | emitted as |
|---|---|---|
| `at-most-one-<C>-per-run` | C never occurs twice in any episode | `path.count(C) <= 1` |
| `no-<C>-without-a-prior-<V>` | V precedes C in ≥ 40% of instances and C is consequential | `path.emitted.every(e => e.kind !== C \|\| path.emitted.some(v => v.kind === V && v.step < e.step))` |
| `<C>-implies-a-prior-<S>` | S precedes C in ≥ 90% of instances | as above |
| `exactly-one-<S>-when-started` | S occurs exactly once in >= 90% of episodes containing C | `started ? n === 1 : n === 0` |

All four are computed over the instances of a subject. None of them require a
sequence to repeat.

#### 4.4.1 Where a rule's evidence has to come from

A proposal is normative — it asks you to do something you did not always do. That
is only legitimate while the norm is *yours*, so every proposed rule carries its
provenance and the three cases are presented differently:

| provenance | condition | how it is offered |
|---|---|---|
| **own** | the rule holds in ≥ 60% of this project's instances of the subject | proposed, with the exceptions listed. "You did this 12 of 14 times." |
| **borrowed** | it holds in ≥ 3 of your *other* projects and has < 60% support here | shown separately, never in the proposal by default. "Five of your other projects do this; this one does not." |
| **neither** | no support anywhere in the corpus | **not proposed at all**, at any confidence |

The measurement in §1.2 is why. A project with 7 pushes, 1 verification run and
0 verified pushes has no own-evidence for verify-before-push. Proposing it there
would be importing an opinion under the appearance of a finding — and a tool that
does that once is a linter, which is a thing people mute.

Borrowed rules are the interesting middle and are deliberately quiet in v0: shown
on request, never in the default proposal. A user who wants their standards
spread across projects can ask; a user who does not should never be told what
their other repositories imply about this one.

Every proposed rule is printed with its support and its counter-evidence. A rule
at 55% support is offered as a *decision* — "this would have stopped 35 of 77" —
not as something the data discovered.

### 4.5 State on disk

```
.polyness/
  corrections.json     per project: the real verification command, false positives
  shapes.sqlite        mined shapes, cached by journal mtime so audit is fast twice
  proposals/<name>/    contract.json · effect-invariants.mjs · polyflow.workflow.json · NOTES.md
```

Per project, beside `.polycrew/`. Never written outside the project directory,
and journals are opened read-only.

### 4.6 Handing off

polyness writes a proposal; it does not decide anything.

- **polygen** authors the SAM machine from the contract. It already does this.
- **polyflow's admission gate** enumerates every reachable path and either
  registers the workflow or refuses it, naming the rule and the counterexample.
  A proposal that fails is not a warning — the workflow cannot be started.
- **polycrew** runs it when more than one session is involved. Nothing in
  polyness knows about crews.

This is the property the JIT-Agent line of work does not have: a generated
artifact that is *checked against a stated rule* before it can run, rather than
validated for executability and then scored.

### 4.7 Recognition

For each admitted workflow, its emitted shape is a sequence of kinds. The
recogniser holds a rolling window of the current session's normalised records and
reports a match when a prefix of length ≥ 2 aligns and the next expected kind has
not yet occurred. Ambiguity between workflows is reported as ambiguity.

v0 reads the live transcript by tailing the session's JSONL. This is a
deliberately poor mechanism — it lags, and it cannot see a command before it runs.
§6 replaces it.

---

## 5. Acceptance

v0 is done when, on a corpus not written for it:

1. `audit` reproduces both §1 and §1.1 - the pooled numbers and the per-project
   breakdown - and `--show` traces every one of the 35 to a project, session,
   timestamp and command. On a project below the support floor it says so
   plainly and proposes nothing; seventeen of thirty-two projects here are in
   that state, and a tool that manufactures a finding for them is worse than one
   that stays quiet.
2. `--correct` on a mis-classified project changes the number, and the change
   survives a re-run.
3. `propose` emits a proposal for the push shape that **polygen can author and
   polyflow's gate admits** — end to end, without hand-editing.
4. That workflow, run under polyflow, refuses to reach its push step on a path
   where verification did not pass. Demonstrated, not asserted.
5. `watch` names the right workflow from a held-out episode's first three steps,
   on more episodes than it gets wrong.

(5) is the weakest and is expected to stay weak in v0. It is measured anyway, so
v1 has a baseline to beat.

---

## 6. What v1 adds, and why it is not v0

Today's journal records actions and transport errors. It has no state, no real
outcomes, no task labels, and — measured, not assumed — **no recoverable record
of a refused tool call.**

Claude Code's hooks close all four, and this machine already runs a `PreToolUse`
hook, so it is configuration rather than a fork:

| gap | hook | what it gives |
|---|---|---|
| no `pre`/`post` state | `PostToolUse` | `git rev-parse HEAD`, branch, dirty — a shape becomes a transition system rather than a string |
| outcomes are transport-level | `PostToolUse` | exit code and classified result; §1 stops being soft |
| a session is not a task | `UserPromptSubmit` | episode boundaries and the intent in the user's own words |
| refusals are invisible | `PreToolUse` | **every denial is a rule someone already believes, stated when it mattered** |
| edits unlinked to verification | `PostToolUse` | which files changed before which command passed |

The journal that hook writes should be polyrun's format, which is already a valid
Polygraph trace corpus — then the gate consumes it with no translation.

The staging is the point. **v0 asks for nothing and gives a number.** v1 asks for
a hook, and has already earned the right to.

---

## 7. Privacy

Journals contain everything: source, commands, customer names, secrets pasted
into a terminal.

- Local process, local files, no network. Not configurable in v0, because a flag
  is a thing someone can turn on by accident.
- Journals are opened read-only. Nothing is copied out of `~/.claude/`.
- `arg` is truncated to 512 characters and redacted against common secret shapes
  before it is written to `.polyness/` or printed.
- `polyness audit --export` exists for sharing a finding and emits *counts and
  shapes only*, never command text.

This is the same stance as polycrew's loopback-only rule, for the same reason:
the boundary should be a property of the design, not a setting.

---

## 8. Where polyness sits, and why not on polycrew

polyness depends on **polyflow**, not on polycrew. The dependency runs the same
direction as polycrew's own: down, toward the single-participant engine.

```
   polyness   ──reads──▶  a journal        ──proposes──▶  a workflow
      │                                                        │
      └──────────────── polyflow ◀────────── admits or refuses ─┘
                            ▲
                        polycrew          only when more than one participant
                                          runs what polyness proposed
```

Mining is a read-only batch over local files. It has no orders, no claims and
nothing to share, so building it on the coordination layer would add a broker to
a program that has nothing to coordinate. polycrew enters at *run* time, if the
workflow polyness proposed is worked by several sessions — and polyness does not
need to know that happened.

### 8.1 Getting beyond one host

The concern is real: a tool that reads `~/.claude/projects` is a Claude Code
tool by construction, and the interesting corpus is every agent, not one.

Two things carry it, and neither is polycrew.

**Recognition and proposal ship as MCP tools, not as a CLI.** `workflow_suggest`
beside `workflow_list` puts them in front of every host already speaking MCP —
OpenWorker, Kiro, Hermes, the DeepSeek Harness — with no per-host work at all.
The CLI stays for the audit, which is a thing you read rather than a thing an
agent calls.

**The second corpus is polyflow's own journal, and it is host-neutral by
construction.** Once work runs through polyflow, every step is already recorded
as `(action, data, pre, post, actor, action_id)` — with the state that §6 has to
add hooks to recover from Claude Code, and with no dependence on which agent was
driving. It is already a valid Polygraph trace corpus. A second host needs no
reader, no normaliser and no alphabet: it needs to have run something.

So the reader interface in §4.1 has exactly two implementations worth building,
and they are not two agents:

| corpus | when it applies | what it costs |
|---|---|---|
| the host's native journal | **cold start** — before anything runs through polyflow | one reader and one normaliser per host, and everything in §1.3 about classifiers being soft |
| polyflow's journal | from the first admitted workflow onward | nothing; it is the trace corpus already |

That is the on-ramp, and it is why v0 reads Claude Code's transcripts despite
their gaps. **Mine the journal you already have, propose your first workflow,
and from then on the journal is the good one.** Each host needs a reader only
until its first workflow runs.

---

## 9. Open questions

1. ~~One corpus produced one workflow - is that this machine, or general?~~
   **Answered in §1.1, and it changed the design.** At single-project scale
   sequence mining yields 3% and event mining yields 22%. What remains unknown
   is the floor: seventeen of thirty-two projects are too small to say anything
   about, so polyness has to be able to say "not enough history yet" without
   that reading as a failure.
2. **How is a shape named?** `verified-push` was chosen by hand here. Episode
   intent text is the obvious source, and it is the one part of the pipeline that
   wants a model.
3. **When does a proposal go stale?** A workflow admitted from June's history may
   not describe September's repo. polyvers gates a *changed* workflow against
   in-flight runs; nothing yet gates an *outdated* one against changed practice.
4. ~~Does recognition belong in polyness at all?~~ **Answered in §8.1: it ships
   as an MCP tool.** A watcher tailing a JSONL file is a Claude Code feature; a
   tool beside `workflow_list` is available to every host that speaks MCP, and
   it can see a step before it runs rather than after.
5. **Does the host reader earn its keep?** §8.1 argues each host needs one only
   until its first workflow runs. If cold-start mining reliably produces nothing
   on a small project (§1.1: seventeen of thirty-two), the on-ramp may be too
   narrow to be worth a reader per host — and the honest alternative is to ship
   one hand-written starter workflow and let the journal accumulate.
