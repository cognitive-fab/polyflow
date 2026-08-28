# polyness v0 — implementation plan

The MVP: read the journals an agent already writes, show a person the thing they
keep doing and the guard they keep skipping, propose that as a workflow their own
history supports, and put it through polyflow's gate. Spec:
[`polyness-spec.md`](polyness-spec.md).

## Four decisions, settled

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

## Steps

Each is one commit with a test that proves it, ordered so nothing is built on an
unverified assumption.

| # | What | Test |
|---|---|---|
| **0** | **The far end, first.** Hand-write the proposal artifacts for `verified-push` exactly as the miner would emit them — contract, invariants, descriptor, no machine. polygen authors the machine; polyflow's gate rules on it. | The workflow is admitted, and a run **refuses to reach its push step** on a path where verification did not pass. If polygen cannot author from a mined-shaped contract, v0 is audit-only and we know on day one. |
| 1 | **Reader and normaliser.** Stream Claude Code JSONL into the normalised record (spec §4.2): alphabet from the command not the tool, outcome classification, episodes split on user prompts. | Exact expected records from a fixture transcript. Then, as a smoke test against the real corpus: 414 sessions, 150 with tool calls, 28,382 calls. |
| 2 | **Corrections.** Per-project store, `--correct`, re-classification. | Correcting a project's verification command changes its numbers, and the change survives a re-run. A project whose outcome cannot be classified reports `unknown` and is counted as neither. |
| 3 | **Subjects, rules, provenance.** Consequential events with ≥5 instances; the four rule patterns; own / borrowed / none (spec §4.4.1). Every rule carries its support **and the date it was mined**; the thresholds are parameters, not constants. | Reproduces §1.2 exactly — 12/14, 11/11, 10/10, 9/10 — and proposes **no** rule for the project with 7 pushes and 1 verification run. That refusal is the test. |
| 4 | **`polyness audit`.** Per-project output, `--show`, the below-floor message. | Every number in the output traces to specific journal records via `--show`. A project under the floor says "not enough history yet" and proposes nothing; seventeen of thirty-two here are in that state. |
| **4b** | **Enforcement point** (polyflow-side). A `PreToolUse` adapter that denies a tool call with no matching open order. The descriptor's `tools` block stops being documentation and becomes the correspondence contract. | The weakened `verified-push` from step 0, run for real: the agent attempts the push after a failed verification and the call is **denied**, not merely un-ordered. And the gate refuses admission to a workflow asserting an invariant over an effect the adapter cannot recognise. |
| 5 | **`polyness propose`.** Emit the proposal directory from a mined subject, then hand off. | The same artifacts as step 0, **produced rather than hand-written**, admitted by the gate without hand-editing. |
| 6 | **Recognition as an MCP tool.** `workflow_suggest` on polyflow's surface, not a CLI watcher (spec §8.1). | Given a held-out episode's first three steps, names the right workflow more often than it gets it wrong. Expected to be weak; measured anyway so v1 has a baseline. |

## Where the risk is

**Step 0 decides the shape of the product.** Everything from step 3 onward
assumes a mined contract can become an admitted workflow. If polygen cannot
author a machine from the contract a miner would emit, then v0 is an audit and a
report, proposal is v1, and steps 5 and 6 do not exist. That is worth knowing
before the miner is written, not after — which is why it is step 0 rather than
step 5.

**Step 5 is blocked on a key, not on a design.** polygen recommends opus-5 and
only a DeepSeek key is present, which is why step 0's machine is hand-authored.
The gate path is proved; the automation is not. Settle the key before step 5
starts, or step 5 becomes "hand-author from a generated contract" and the claim
weakens accordingly.

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
      *Not done:* polygen's leg. It needs a model call and only a DeepSeek key is
      present while polygen recommends opus-5, so the machine is hand-authored to
      the same contract — which proves the gate path and not the automation.
      4 tests.
- [ ] 1 — reader and normaliser
- [ ] 2 — corrections
- [ ] 3 — subjects, rules, provenance
- [ ] 4 — `polyness audit`
- [ ] 4b — enforcement point (polyflow-side)
- [ ] 5 — `polyness propose`
- [ ] 6 — recognition as an MCP tool

The measurement v0 is built to produce, on a corpus nobody prepared for it: **a
workflow proposed from a user's own history, admitted by the gate, that would
have stopped something they actually did.** Two of fourteen, in the first
project it was pointed at. Step 4b is what turns *would have* into *did* — the
same rule, binding on the call rather than on the work order.
