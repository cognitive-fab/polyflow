# polyness v0 — implementation plan

The MVP: read the journals an agent already writes, show a person the thing they
keep doing and the guard they keep skipping, propose that as a workflow their own
history supports, and put it through polyflow's gate. Spec:
[`polyness-spec.md`](polyness-spec.md).

## Five decisions, settled

**Its own repository**, `cognitive-fab/polyness`, pinned to polyflow the way
polycrew is. v0's entire pitch is *install nothing, read a directory*; asking
someone to clone a workflow engine to run an audit contradicts it. polyness
depends on polyflow and never on polycrew (spec §8).

**Corrections are built before conclusions.** Ordinarily the store would come
last. Here §1.3 settles it: one change to the verification regex moved a project
from "7 pushes, 0 verified" to "14 pushes, 12 verified". Every number this tool
prints is downstream of a classifier that is wrong somewhere, so the means of
correcting it ships before anything that quotes it.

**Node, no build step, `node:sqlite`.** Same constraints as polyflow and
polycrew. The corpus is 647 MB of JSONL on this machine, so every reader is
streamed and nothing holds a transcript in memory.

**Enforcement is polyflow's job, not polyness's.** polyness proposes and audits.
Making a rule bind on the *effect* rather than on the work order is an
enforcement point inside the host harness, and it belongs beside the gate that
ruled on the rule. It appears in this plan at all because polyness's headline
claim depends on it: today the gate certifies that a workflow will never
**order** an unverified push, which is not the sentence a reader hears.

**Learning is replay, not retraining.** Nothing here fine-tunes anything. What
improves is the rule set, and it improves because a rule is a predicate that can
be scored against a corpus — before adoption, and again later. Two consequences
settle the scope: intake is unlimited (a rule from anywhere can be replayed,
§4.4.1's floor governs only what is *proposed*), and rules can be retired, which
is the thing a memory file cannot do. The mechanism costs one CLI surface over
work steps 1–3 already do.

## Steps

Each is one commit with a test that proves it, ordered so nothing is built on an
unverified assumption.

| # | What | Test |
|---|---|---|
| **0** | **The far end, first.** Hand-write the proposal artifacts for `verified-push` exactly as the miner would emit them — contract, invariants, descriptor, no machine. polygen authors the machine; polyflow's gate rules on it. | The workflow is admitted, and a run **refuses to reach its push step** on a path where verification did not pass. If polygen cannot author from a mined-shaped contract, v0 is audit-only and we know on day one. |
| 1 | **Reader and normaliser.** Stream Claude Code JSONL into the normalised record (spec §4.2): alphabet from the command not the tool, outcome classification, episodes split on user prompts. | Exact expected records from a fixture transcript. Then, as a smoke test against the real corpus: 414 sessions, 150 with tool calls, 28,382 calls. |
| 2 | **Corrections.** Per-project store, `--correct`, re-classification. | Correcting a project's verification command changes its numbers, and the change survives a re-run. A project whose outcome cannot be classified reports `unknown` and is counted as neither. |
| 3 | **Subjects, rules, provenance.** Consequential events with ≥5 instances; the four rule patterns; own / borrowed / none (spec §4.4.1). Every rule carries its support **and the date it was mined**; the thresholds are parameters, not constants. | Reproduces §1.2 exactly — 12/14, 11/11, 10/10, 9/10 — and proposes **no** rule for the project with 7 pushes and 1 verification run. That refusal is the test. |
| **3.5** | **`polyness replay`** (spec §3.4). Score any rule — mined, admitted, or supplied from outside — against the corpus: holds, would-have-blocked, blocked-then-succeeded. Reuses step 3's predicates and step 1's records, so it is a CLI surface over work already done. | Scores a rule the tool did not mine, and refuses to propose one below the floor. Proved on a rule that **passes on one project and fails on another** from the same corpus — a scorer that only ever agrees with the miner has not been tested. |
| 4 | **`polyness audit`.** Per-project output, `--show`, the below-floor message, and stale-rule reporting for admitted workflows whose support has decayed. | Every number in the output traces to specific journal records via `--show`. A project under the floor says "not enough history yet" and proposes nothing; seventeen of thirty-two here are in that state. |
| **4b** | **Enforcement point** (polyflow-side). A `PreToolUse` adapter that denies a tool call with no matching open order. The descriptor's `tools` block stops being documentation and becomes the correspondence contract. It also writes the **decision journal** (spec §4.8) — allow, deny, and deny-then-overridden — which is the only source of labelled negatives in the system. | The weakened `verified-push` from step 0, run for real: the agent attempts the push after a failed verification and the call is **denied**, not merely un-ordered. And the gate refuses admission to a workflow asserting an invariant over an effect the adapter cannot recognise. A denial the user overrides appears in the journal as an overridden denial and is visible to `replay`. |
| 5 | **`polyness propose`.** Emit the proposal directory from a mined subject, then hand off. | The same artifacts as step 0, **produced rather than hand-written**, admitted by the gate without hand-editing. |
| 6 | **Recognition as an MCP tool.** `workflow_suggest` on polyflow's surface, not a CLI watcher (spec §8.1). | Given a held-out episode's first three steps, names the right workflow more often than it gets it wrong. Expected to be weak; measured anyway so v1 has a baseline. |

## Where the risk is

**Step 0 decides the shape of the product.** Everything from step 3 onward
assumes a mined contract can become an admitted workflow. If polygen cannot
author a machine from the contract a miner would emit, then v0 is an audit and a
report, proposal is v1, and steps 5 and 6 do not exist. That is worth knowing
before the miner is written, not after — which is why it is step 0 rather than
step 5.

**Step 5 needs a key at the time it runs.** The design question is answered —
polygen authors an admissible machine from a mined-shaped contract (step 0
status). What remains is operational: opus-5 credentials must be available when
step 5 executes, and the contract emitter must satisfy the disjoint-branch rule
the 2026-08-27 run produced. A contract that fails that rule does not fail
loudly; it fails as a repair loop that never converges.

**Step 3's thresholds are guesses.** ≥5 instances, ≥60% for own evidence, ≥3
projects for borrowed. They are set from one corpus and its test pins them
against that corpus, which is circular. They should be revisited the first time
polyness runs somewhere else, and the spec should carry them as parameters
rather than constants.

**Step 4b's hard part is correspondence, not plumbing.** The adapter sees
`git push origin main`; the order book has an open `push` order. A loose match is
a hole and a strict match jams the moment an argument changes. The `tools` block
already declares the tool per effect kind; turning that into a matching contract
is the whole of the work, and every claim the adapter makes rests on it.

**Step 6 is expected to fail its own bar.** Recognition from a three-step prefix,
against a journal with no state and no intent labels, is the weakest thing here.
It ships anyway because the number is what justifies the v1 hooks (spec §6).

**The frame is converging, and that cuts both ways.** Graph-shaped orchestration
is becoming the mainstream position in 2026, which helps adoption and erases
"workflow as state machine" as a differentiator. What does not converge is the
gate. Two consequences for how this is written up: lead with admission rather
than with the graph, and note that when workflows are *generated* rather than
authored there is nobody left to ask why a rule is there — the support count and
the mined-on date are the only audit trail such a rule can have. That is what
step 3's provenance is for, beyond §4.4.1's legitimacy argument.

Steps 1, 2 and 4 are mechanical once 0 has answered.

## Status

- [x] **0 — the far end.** [`cognitive-fab/polyness`](https://github.com/cognitive-fab/polyness)
      exists, pinned to polyflow v0.4.2. `proposals/verified-push/` is a workflow
      written by hand to exactly the shape the miner will emit, admitted at 5
      paths, 8 states, exhaustive. The decisive test is the fourth: weaken it the
      one way a careless author would — let a failed verification carry on to
      staging instead of ending the run, rules file and effect mapper untouched —
      and the gate refuses it, naming the path
      `START → VERIFY_FAILED → STAGED → COMMITTED → PUSH_FAILED` and the `push`
      it would have emitted. `begin()` then rejects, because a refusal is not a
      warning. **The propose path is viable; v0 is not audit-only.**
      4 tests.
      **polygen's leg, closed 2026-08-27.** Run against the same contract with
      `--model opus-5`, polygen's authored machine — polyness's mined
      `effect-invariants.mjs` untouched — is admitted at the *same* certificate
      as the hand-written one (5 paths, 8 states, exhaustive), refuses the push
      on a failed verification, and completes the happy path. The automation is
      proved, not only the gate path.
      It took two runs, and the first one is the finding: with `specialRules`
      that named `VERIFY_FAILED` in two rules without declaring the branches
      disjoint, the repair loop oscillated between an invariant violation and a
      reject-after-write throw and never converged. Disambiguating the rules —
      and nothing else — converged on iteration 0. **Step 5's emitter inherits
      that as a requirement**, see the build plan.
- [x] **1 — reader and normaliser.** Streamed; the alphabet, redaction and
      outcome classification. Nine review findings, all wrong-number bugs: the
      classifier read 460 failures against 25 passes corpus-wide because bare
      `assert` counted as a failure.
- [x] **2 — corrections.** One job, because `gitOperation` removed the other:
      what counts as a verification HERE. Eleven review findings, two of which
      moved a number at random.
- [x] **3 — subjects, rules, provenance.** Reproduces §1.2's claim — of the ten
      projects running a verification 5+ times, seven verify before pushing.
      The guard window is the session and the run window is the episode,
      because those are different questions.
- [x] **3.5 — `polyness replay`.** Demonstrated on one supplied rule across the
      real corpus: four projects keep it, six do not.
- [x] **4 — `polyness audit`.** 6 of 31 projects have a step worth proposing
      and 25 do not, in those words. `--show` traces every figure to records.
- [x] **4b — enforcement point.** In polyflow: `src/match.mjs`,
      `src/decisions.mjs`, `adapters/claude-code/gate.mjs`. A run whose
      verification failed has its push DENIED at the tool, not merely
      un-ordered. Default allow; fail-closed narrowly; gating opt-in per
      effect via `match`.
- [x] **5 — `polyness propose`.** Not blocked on the key after all: the key
      gated polygen's leg, and propose is the emitter. Every contract carries
      the disjoint-branch rule the 2026-08-27 polygen run produced, and the
      emitter refuses to write a predicate naming an action the contract does
      not declare.
- [x] **6 — recognition as an MCP tool.** Fails its own bar, as predicted, and
      the number is recorded rather than asserted away: 1 right against 15
      wrong at a three-step prefix, over 1,758 episodes. That is what §6's
      hooks have to beat.
- [x] **README, a runnable example, and a getting-started guide.**
      `examples/verified-push/run.mjs` runs the whole path on fifteen sessions
      written out in the file, and a test checks every number its README claims
      is one the run prints.

**Seven review rounds, 63 findings fixed.** polyness: 164 tests. polyflow: 48.

The measurement v0 is built to produce, on a corpus nobody prepared for it: **a
workflow proposed from a user's own history, admitted by the gate, that would
have stopped something they actually did.** Two of fourteen, in the first
project it was pointed at. Step 4b is what turns *would have* into *did* — the
same rule, binding on the call rather than on the work order.
