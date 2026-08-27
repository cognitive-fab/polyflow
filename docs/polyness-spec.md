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

---

## 2. Goal, and what v0 is for

The goal is **identify repeatable workflows and run them as such in a given
situation.** Three verbs, in order:

1. **Audit** — show what you repeat and where the repetition already goes wrong.
2. **Propose** — turn a recurring shape into a workflow with rules, and put it
   through polyflow's admission gate. A proposal that fails the gate is refused,
   not flagged.
3. **Recognise** — when a session starts doing something a workflow covers, say
   so and offer to start the run.

v0 ships all three, narrowly. Audit works on the journal that exists today with
nothing installed. Propose emits one candidate. Recognise suggests and never
acts.

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

  53 projects · 414 sessions · 150 with tool calls · 28,382 calls

  Repeated shapes ending in something you cannot take back

    git add → git commit → git push            6 projects   41 times
      ⚠ 35 of 77 pushes had no passing test before them
         kanjo 13 · baanbaan-Merchant 7 · cognitive-fab 4 · glm 3 · …
         polyness audit --show unverified-push   to see them

    npm test → git add → git push              3 projects   12 times

  1 shape is worth proposing as a workflow.   polyness propose
```

`--show <finding>` lists the underlying steps: project, session, timestamp, the
command, and what came before it. Every number the tool prints must be traceable
to specific journal records in one command. A user who cannot check a claim will
not believe the next one.

`--correct` teaches it: mark a listed step as a false positive and name the
project's real verification command. Corrections are stored per project (§4.5)
and every later number reflects them.

### 3.2 `polyness propose <shape>`

Turns a shape into a workflow proposal.

```
$ polyness propose "git add → git commit → git push"

  From 41 runs across 6 projects.

  Steps          stage → commit → push
  Rules          derived from your history, and how it would have gone:
                   no-push-without-a-passing-verify     would have stopped 35 of 77
                   at-most-one-push-per-run             never violated (77/77)
                   commit-implies-a-prior-stage         never violated (41/41)

  Written to     .polyness/proposals/verified-push/
                   contract.json          the states, actions and their domain
                   effect-invariants.mjs  the three rules above
                   polyflow.workflow.json the effect surface and run key
                   NOTES.md               which runs this came from

  The machine itself is not written. Next:
    polygen author .polyness/proposals/verified-push
    polyflow admit .polyness/proposals/verified-push
```

A rule is only proposed when the history supports it (§4.4). Each is printed
with its own counter-evidence, because a rule that your own history violates
half the time is a decision, not a discovery — and the person reading has to
make it.

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

**Shapes.** Within an episode, immediate repeats collapse (`Read Read Read` is
`Read`). A shape is a window of 3–5 consecutive kinds. A shape is a *candidate*
when it occurs in ≥ 3 distinct projects and ends in a step matching the
consequential set: `git push`, `git commit`, `git tag`, `npm publish`,
`gh pr create`, `gh release`, `docker push`, plus per-project additions.

Consequence is the filter that makes this tractable. Everything recurs; only some
of it is worth a gate.

**Ranking is by regret**, not frequency: how often the shape ran *without* the
guard the rest of its instances had. A shape that is always done correctly is not
worth a workflow. The one in §1 ranks first because 45% of its instances skipped
verification.

**Rules.** Candidates are drawn from a fixed vocabulary that maps one-to-one onto
polyflow's effect-invariant predicates — the same `path.count`, `path.emitted`,
`path.actionBefore` used by every hand-written workflow in the repo:

| pattern | proposed when | emitted as |
|---|---|---|
| `at-most-one-<C>-per-run` | C never occurs twice in any episode | `path.count(C) <= 1` |
| `no-<C>-without-a-prior-<V>` | V precedes C in ≥ 40% of instances and C is consequential | `path.emitted.every(e => e.kind !== C \|\| path.emitted.some(v => v.kind === V && v.step < e.step))` |
| `<C>-implies-a-prior-<S>` | S precedes C in ≥ 90% of instances | as above |
| `exactly-one-<S>-when-started` | S occurs exactly once in ≥ 90% of episodes | `started ? n === 1 : n === 0` |

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

1. `audit` reproduces §1's numbers, and `--show` traces every one of the 35 to a
   project, session, timestamp and command.
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

## 8. Open questions

1. **One corpus produced one workflow.** Is that this machine, or is it general?
   If most users get zero candidates, the audit is the product and proposal is a
   feature. That is knowable early and should be checked before §3.2 is built.
2. **How is a shape named?** `verified-push` was chosen by hand here. Episode
   intent text is the obvious source, and it is the one part of the pipeline that
   wants a model.
3. **When does a proposal go stale?** A workflow admitted from June's history may
   not describe September's repo. polyvers gates a *changed* workflow against
   in-flight runs; nothing yet gates an *outdated* one against changed practice.
4. **Does recognition belong in polyness at all?** It could be a polyflow tool —
   `workflow_suggest` beside `workflow_list` — which would put it in front of
   every agent already speaking MCP rather than behind a separate watcher.
