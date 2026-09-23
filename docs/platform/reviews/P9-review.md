# Review: P9 (hardening and acquisition evidence), and the rows built since the P6–P8 review

This is an adversarial review of what was built after the P6–P8 review:

- **P9 evidence:** the DST harness (`temporal/test/dst.test.mjs`), the pass^k harness (`temporal/test/passk.test.mjs`, `fixtures/passk-workflows.mjs`), and the NFR-13 measurement (`temporal/test/acceptance.test.mjs`, memo now opt-in).
- **Rows from external feedback 1:**
  - P2.6 sealed headers: `kernel/src/{aead,sealed-header}.mjs`, and the wiring in `plugin.mjs` and `workflow-interceptors.mjs`.
  - P4.6 policy ramp gate: `kernel/src/policy-ramp.mjs`, `gate-workflow.mjs`, `gate-activities.mjs`.
  - P5.5 verified principals: `kernel/src/{ed25519,principal}.mjs`, `temporal/src/principals.mjs`, and action-bound tokens.
  - P5.6 frozen approval arguments.
  - P7.3a routes and the P7.3 OpenAI Agents SDK sample.
  - P7.4 QuickJS G2: `python/polyflow_temporal/{machine_host,quickjs_engines}.py`, `research/05-quickjs-g2-spike.md`.
- **Also:** the Worker Versioning gate (`versioning.test.mjs`), and the WT structural checks in `kernel/src/explore.mjs`.
- **The acquisition brief** (`04-acquisition-brief.md`). Every number and claim in it was checked against the code and the tests.

The P9 security review's findings are not reviewed again here. Where this review checked that review's **Response**, it says so. Three of the Response's claims do not hold in the code: SEC-MG1, SEC-PR1 and the DEP half of SEC-CT1.

The reviewer did not write the code and changed no production code. **The tree moved during the review.** `workflow-interceptors.mjs` changed at 20:58, while the review was being written, so line numbers are as of 21:15. Every finding below was re-run against the tree at 21:10 or later.

## How to reproduce

Each review test asserts what the plan, the brief, the P9 security Response or the module's own header claims. Each one **fails today**, for the reason its message gives. The positive controls (GF3, DEP0) pass.

| File | Tests | Needs server |
|---|---|---|
| `platform/packages/kernel/test/review-p9-kernel.test.mjs` | RP1, RP2, RP3, RP4 | no |
| `platform/packages/cli/test/review-p9-admit.test.mjs` | WT1, DEP1, DEP2 (and control DEP0) | no (about 1 s) |
| `platform/packages/temporal/test/review-p9-gate.test.mjs` | GF1, GF2 (and control GF3) | no (stub client) |
| `platform/packages/temporal/test/review-p9-temporal.test.mjs` (+ `fixtures/review-p9-workflows.mjs`) | HO1, AP1, PR1, MG1, RT1, SH1 | yes (about 20 s) |
| `platform/packages/temporal/test/review-p9-dst.test.mjs` | DST1 | yes (about 15 s) |
| `platform/packages/temporal/test/review-p9-versioning.test.mjs` | VG1 | yes. It starts its own dev server with `limit.historyCount.suggestContinueAsNew=40` |
| `platform/python/tests/test_review_p9.py` | QJ1, QJ2, QJ3 | no (it calls `node` for the TS side) |

```
cd platform/packages/kernel   && node --no-warnings --test test/review-p9-kernel.test.mjs
cd platform/packages/cli      && node --no-warnings --test test/review-p9-admit.test.mjs
cd platform/packages/temporal && node --no-warnings --test test/review-p9-gate.test.mjs
cd platform/packages/temporal && node scripts/test-each.mjs review-p9-temporal review-p9-dst review-p9-versioning
cd platform/python            && .venv/Scripts/python.exe -m pytest -q tests/test_review_p9.py
```

**Baseline at review time:**

- kernel: 78/78 before the review file.
- cli: 27/27 before the review file.
- temporal: `dst`, `passk`, `acceptance`, `versioning`, `policy-ramp`, `sealed-headers` and `principals` pass 12/12.
- python: `test_s2_openai_agents.py` and `test_quickjs_g2.py` pass 194/194.

**All 20 review tests fail**, and the two controls pass. Every Temporal review test terminates the runs it starts, or lets them complete. No activity is left parked. Temporary machine directories go under `examples/.tmp-review-p9-*`, and they are removed.

Three probes were run as throwaway scripts, not committed. Their results are quoted where they are used:

- **Seed 9's ledger writes and headers.** This is how HO1 was found.
- **History size as protobuf** (`History.encode`), next to the harness's `JSON.stringify` size.
- **The pass^k table recomputed from the PRNG alone**, with no Temporal.

---

## Summary

**3 blockers, 13 majors, 8 minors, 3 nits.**

| # | Severity | Finding | Evidence |
|---|---|---|---|
| HO1 | **blocker** | An Update that a governed run accepts while it hands over (Continue-as-New) is answered "accepted" and then lost. `handOver()` builds the carried snapshot *before* the Continue-as-New interceptor flushes the ledger. The flush is an activity round trip, and an Update accepted during it steps a state nobody carries. The next execution is back in the old state, and the order is open again. The ledger records events after its own `closure` and forks at the next seq. | HO1, DST1, probe |
| AP1 | **blocker** | P5.6 does not hold: "the approved call executes unchanged". A parked call keeps a *reference* to the workflow's argument objects, and they are serialised only when `next()` runs after the approval. The workflow edits the draft while the call waits. The approver approves the digest they were shown. The activity then runs with a different recipient, and the ledger records the approved digest. | AP1 |
| MG1 | **blocker** | SEC-MG1 is reopened through the SEC-PR1 fix. A migrate token is bound to `{ op, wf, ref: from }`, not to the snapshot. After an identity migration (the gate's auto-upgrade), the next execution holds the same state, so `from` still matches. Anyone who can read history lifts the gate's token and migrates the run into any non-terminal state. A run waiting for approval goes to `posting`, where it can neither post nor stop. | MG1 |
| DST | major | The DST passes on a schedule that forked the ledger and lost an acknowledged Update (seed 9, reproduced 3 times out of 3). Its I3 check verifies only the prefix the sink kept. I1 and I5 read only the last execution's journal. There are no concurrent stimuli, and the 20 schedules make 92 stimuli and 3 hand-overs in total. | DST1, the `[DST]` line |
| PR1 | major | The SEC-PR1 Response says a token lifted from history "authorises only the action it already recorded". That is true for `approve` only. `report` binds the order, not the outcome or the result: after a retryable failure the order stays open, and the lifted token reports success with a forged result. `propose` binds the action name, not the data. `version` binds nothing but `op`. | PR1 |
| RT1 | major | The trust store is not stable under replay. The approval handler (and every GovernedWorkflow handler) verifies the token again **on replay**. Rotate a revoked approver key out of `principals`, and every run that holds an approval by it fails its next workflow task. | RT1 |
| SH1 | major | Turning P2.6 on wedges live fleets. A worker with `headerKey` refuses the plaintext head that a pre-sealing worker handed over at Continue-as-New (`required: true`). Every chain that continued before the rollout fails its next workflow task. There is no migration mode. | SH1 |
| VG1 | major | A run gated with `onVersionChange` waits for promotion. When Temporal suggests Continue-as-New during the wait, `handOver()` carries the migrated snapshot, computed for v2, onto **v1**, and forgets the migration. A same-shape migration is applied early on the wrong version. A shape change is quarantined. | VG1 |
| RP | major | The policy ramp gate (P4.6) answers a different question than it states. It compares allowed **kind names**, not what a run may call, so reclassifying an activity under a surviving kind name is a "move" (RP1). Effects allowed through `unlabelled` are never compared (RP2). A renamed, tightened budget starts a fresh meter and passes (RP3). The plan row's own test (a tightened budget) was never written. The brief says runs are "named and pinned", but nothing pins. | RP1–RP3 |
| GF | major | The gate fails open. A run whose `polyflow.guard` query fails, as it does while its workers are rolling, is skipped as "not governed". Runs under any other policy digest are dropped, and an empty fleet is `ok: true`. The G2 gate refuses an empty fleet; this one does not. | GF1, GF2 |
| WT1 | major | `every-wait-has-an-exit` asks whether *some* incoming stimulus is accepted, not whether each order outcome is. A machine whose `posting` refuses `POST_FAILED` is certified. One failed post strands an unstoppable run for ever. | WT1 |
| DEP | major | The admission package rule is bypassed by `` require(`node:path`) `` and by `require ('node:path')`. The SEC-CT1 fix accepts both as literals, and `moduleProblems` matches only `require('…')`. The Response's "package requires … were already refused at admission" is false for these forms. | DEP1, DEP2 |
| QJ | major | The QuickJS host is "the TS code itself" but not the same semantics. A template-literal require that TS certifies cannot load (QJ1). A certified machine that reads `Date.now()` is `accepted` in TS and silently `unhandled` in QuickJS (QJ2). A mapper defect whose text contains "interrupted" is a poison in TS, and a task failure retried for ever in QuickJS (QJ3). | QJ1–QJ3 |
| NFR | major | NFR-13 miscounts Temporal Cloud Actions, and it measures history size in the wrong unit. A memo upsert is **not** billed, but it is counted. **Queries** and **rejected Updates are** billed, but they are excluded or invisible. `JSON.stringify` of the proto object inflates bytes 3×. As protobuf, the governed 10-step loop is **3.3×** the baseline (4.2× sealed), not "roughly double", at about 1.9 KB per activity (2.8 KB sealed), not 5 KB. | probe, Temporal docs |
| PK | major | The pass^k table is a closed-form function of the PRNG. Recomputed without Temporal or the plugin, it matches to the digit. The policy *is* the success criterion, so "0 unsafe" holds by construction. The "8 tasks" are one task with 8 seeds, and plain pass^4 = 0.00 is small-sample noise: the expectation is 0.14. | probe |
| BR | major | The brief makes claims the code does not support. "GA seams only": plugins and Upgrade-on-Continue-as-New are `@experimental` in SDK 1.24.0. "Parks the exact call": AP1. "Named and pinned": RP/GF. "Every wait has an exit": WT1. "A run never replays across versions … the migration is refused if…": VG1, MG1. And the five DST bullets. | see §BR |
| RP4 | minor | `freshRules` is backwards. It lists `at-most` rules, whose counts come from `s.n` by kind and are not fresh. It omits consuming `requires-prior` rules, whose credits are keyed by rule id and are fresh. | RP4 |
| TK1 | minor | `release` binds `run` but not the snapshot, and a run can be poisoned twice. `claim` binds the order but not the lease. There is no `jti` or single-use record for any op. | code |
| DS2 | minor | The DST's `stale` move is always a digest mismatch, never a decision computed from a state the run really held. A query error ends a schedule silently (`break`). I4 replays whatever visibility lists, with no count check. | code |
| VT1 | minor | `versioning.test.mjs` checks "not moved before promotion" over a 1 s window. It parses the build id with `split('.').pop()`. No Temporal test runs the gate with `gate.principalKey` (a signed migrate). | code |
| SH2 | minor | After sealing is enabled, activities scheduled by pre-rollout code still carry plaintext deltas. The exporter refuses them (SEC-EX2), so they become ledger gaps. | code |
| WT2 | minor | With `externalMode: 'always'`, `order-waits-have-deadlines` failing is a `console.warn` at worker start. The DST runs exactly this configuration: customer-brief's gathering, drafting and posting waits have no deadline. | `plugin.mjs` |
| QJ4 | minor | V8 and QuickJS word `TypeError`s differently, so the poison reason recorded in the journal and ledger differs between the TS and Python hosts. The corpus has no throwing machine. | code |
| BR2 | minor | The brief says all 12 blockers and 59 majors are "fixed or explicitly deferred with a plan row". P2–P3 also closed findings as **narrowed** (for example B1), which is neither. | P2–P3 Response |
| N1 | nit | `acceptance.test.mjs` prints `excluded: … queries (not billed)`. Queries are billed. | `acceptance.test.mjs` |
| N2 | nit | The DST's `posted` count reads the final state, not the effects. | `dst.test.mjs` |
| N3 | nit | `dst.test.mjs` says "a failing seed is a reproduction". That is true only while the system under test is deterministic, and HO1's fork depends on workflow-task timing. It happened to reproduce 3 times out of 3. | — |

---

## Blockers

### HO1: an Update accepted during a hand-over is acknowledged, then lost

`temporal/src/governed-workflow.mjs:558-573`, with `workflow-interceptors.mjs:367-373`.

`handOver()` goes through these steps in order:

1. It cancels open orders.
2. It awaits in-flight work and `allHandlersFinished`.
3. It builds `next = { snapshot: state, … }`.
4. Only then does it call the Continue-as-New function.

The plugin's `continueAsNew` interceptor then runs `close('continued-as-new')`. That call schedules the `polyflow.flush` activity and **awaits it**. The await spans workflow tasks, and every handler stays installed and open while it lasts.

An Update that arrives in that window goes through the full path:

- its validator runs against the live state;
- its handler steps the machine;
- the caller is answered `accepted`;
- the ledger appends to an execution that has already written its `closure`.

Then the Continue-as-New goes out with the `next` built before the Update.

**Evidence.** Test HO1:

- An identity migrate, then a report of the open `fetch_tickets` order. The report is answered `{ stepKind: 'accepted', state: { briefState: 'drafting', ticketCount: 2 } }`.
- The next execution is in `gathering`, with `fetch_tickets` open again.
- The history of the first execution shows `UpdateAccepted(polyflow.migrate)`, then `ActivityTaskScheduled(polyflow.flush)`, then `UpdateAccepted(polyflow.report)`, then a **second** flush, then `ContinuedAsNew`.

The probe dumped the headers:

- The first flush carries seq 0–4, ending in `closure`.
- The second carries seq 5–8 (`observation`, `proposal`, `verdict`, `effect`). That is four events recorded **after** the execution's closure.
- The head handed over is seq 8.

The exporter reports `ledger fork … at seq 5` and a sink conflict at seq 5. The replayed execution's seq-4 closure and the one exported first differ, so the ledger is not replay-stable here either.

The DST hits this on seed 9: its first move is `handover`, and its second is `report:ok`. It stays green (see DST).

**Why it is a blocker.** An acknowledged step disappears. For an agent that means work is done twice: the order is re-issued under the same id, and the agent was told it was accepted. The record also contradicts itself: a closure, then more events.

The same window exists in worker mode (Signals and Updates during the flush), and on every Continue-as-New the loop takes:

- migrations;
- `continueAsNewSuggested`;
- the wake phase.

**Fix.**

- Refuse state-changing Updates once a hand-over has begun. Set a `handingOver` flag before step 3, and have every validator throw a retryable "handing over, retry". Signals should be held and carried (`held` already exists).
- Or build `next` *after* the flush. Move the flush out of the Continue-as-New interceptor into an explicit `drain()` that `handOver()` awaits before it reads the state. Then call Continue-as-New with nothing left to flush.
- Either way, `append` must refuse events once `closure` is written (`closed` is set only after `drainAll`, at `workflow-interceptors.mjs` `close`).
- Add a DST invariant: every Update answered `accepted` appears in the final execution's state or journal.

### AP1: the approved call does not execute the approved arguments

`workflow-interceptors.mjs:185-188`, `:239`, `:296`.

`governed()` computes `aDigest` from `input.args` when the call is proposed. `escalate()` stores `args: args ?? null`, a reference to the same array. After the approval, `next({ ...input, headers })` hands the **same objects** to the SDK, which serialises them only then.

Nothing re-derives the digest after the wait:

- the validator's `seen === p.argsDigest` compares against the stale digest;
- the guard's `approvalFor` matches the approval to `c.argsDigest`, which is also computed before the wait.

**Evidence.** Test AP1 and fixture `editWhileParked`. The workflow hands `send_email` its `draft` object, then keeps editing the draft, as a loop that shares one draft between turns does.

1. The approver queries `polyflow.pending` and sees `to: cfo@acme.example`.
2. The loop sets `draft.to = 'attacker@evil.example'`.
3. The approver approves, naming the digest they saw.
4. The activity runs with `attacker@evil.example`. The ledger's `effect` records the approved digest.

The same aliasing means `polyflow.pending` shows the *current* object, so an approver who queries after the edit sees the new recipient, next to a digest that does not match it.

**Fix.**

- Freeze a copy at proposal: `const frozen = structuredClone(args)` (or a JSON round trip, which is what the digest already assumes). Digest the copy, show the copy, and schedule the copy: `next({ ...input, args: frozen })`.
- Belt and braces: re-digest `input.args` after the wait, and deny `PolyflowDenied: arguments changed while awaiting approval` if it differs.
- Add AP1 to `guard.test.mjs`.

### MG1: the gate's migrate token, lifted from history, moves the run anywhere

`governed-workflow.mjs:513, 526`, `gate-activities.mjs` (`principal({ op: 'migrate', wf, ref: from })`), and `kernel/src/principal.mjs:31` (`covers`).

The SEC-MG1 fix requires a principal signed for `{ op: 'migrate', wf, ref: from }`. The snapshot, `toBuildId` and `shapeChange` are not in `act`, so a valid token authorises *any* migration from `from` for its whole life (5 minutes from `signPrincipal`, and up to 15 minutes allowed). Temporal keeps accepted Update arguments in history, which is SEC-PR1's own threat (A2 and A6).

A migration normally changes the state, so `from` stops matching. An **identity** migration does not:

- the gate's `auto-upgrade` with `onVersionChange` sends `snapshot: d.from`;
- so does the DST's `handover` move.

After the hand-over, the next execution holds the same state, and `from` still verifies.

**Evidence.** Test MG1, with verified principals and customer-brief in external mode:

1. Drive the run to `review`.
2. Make the gate's identity migration with a signed operator token, and wait for the hand-over.
3. Read the token from the first execution's history.
4. Send `migrate { snapshot: { …review state, briefState: 'posting' }, from, principal: lifted }`. It is accepted.

The run is in `posting` with `request_approval` still open:

- no approver decided anything;
- `posting` is declared unstoppable, so STOP is refused;
- no `post_brief` is ever ordered, because migrations do not step.

The run is wedged in a state the gate never decided. On machines where a non-terminal state carries authority (an `approved` flag, a spend level), this is SEC-MG1's original override.

**Fix.**

- Bind the migration's content: `act: { op: 'migrate', wf, ref: from, to: digest(snapshot), toBuildId, shapeChange }`, and check each field in the validator.
- Better still, sign the gate's decision object (review SEC-MG1's own recommendation) and make it single-use: journal the `sig`, and refuse a signature already consumed. Carry the consumed set across Continue-as-New in `results`.

---

## Major

### DST: the harness is green on a fork and a lost Update

`temporal/test/dst.test.mjs`.

The run's own output, from the baseline, 3 times out of 3:

```
[polyflow] ledger export failed: ledger fork for dst-9/… at seq 5
[polyflow] ledger conflict for dst-9/… at seq 5
[DST] {"seeds":20,"stimuli":92,"refused":25,"handovers":3,"posted":5}
ℹ pass 1
```

Test DST1 runs the harness's schedule verbatim, with `onConflict` and `onError` hooks, and fails on seed 9. What each invariant actually checks:

| Invariant | What it checks | What it misses |
|---|---|---|
| I1 "posted at most once" | `POST_DONE` accepted in the **last** execution's journal. The journal is not carried across Continue-as-New (`governed-workflow.mjs:138`). | Earlier executions. It does not count `post_brief` effects in the ledger, which is what "posted" means. |
| I3 "one hash chain" | `verifyChain` over what the memory sink **kept**. The sink refuses a conflicting delta whole, so the kept prefix always verifies. | Forks, conflicts and gaps, which the exporter reports only to `console.error`. |
| I5 "accepted steps are exactly what the machine accepts" | Each accepted journal row replays from its own `pre`: a subset check, on the last execution only. | Rows chaining (`post[i] = pre[i+1]`), the final state equalling the fold, and acknowledged Updates missing from the journal (HO1). |
| I4 replay | Every run that `list` returns, replayed. | A count check against `handovers + 1`; visibility is eventually consistent. |

The schedules are thin:

- 92 stimuli over 20 seeds, at most 30 each: most runs end within 5 moves, because `count: 0` denies the brief.
- 3 hand-overs.
- Stimuli are strictly sequential (each Update awaited), so two Updates never land in one workflow task. "Claims by two agents" are two claims in turn, not a race.
- Worker crashes, activity timeouts and timer firing are not simulated. `maxCachedWorkflows: 0` does give replay on every task, which is real value.

**Fix.**

- Fail on any `onConflict` or `onError`, as DST1 does.
- Assert I1 on the ledger's `post_brief` effects and observations across the whole chain.
- Carry the journal (bounded), or read each execution's journal before it continues.
- Add I6: every Update answered `accepted` is reflected in the next state.
- Fire bursts of concurrent Updates with `Promise.all`.
- Assert `runs.length === handovers + 1`.
- Report per-move coverage, and raise the default seeds until each move and each state is hit.

### PR1: action-bound tokens bind the target, not the content

`governed-workflow.mjs:377, 471, 497, 545`, and `workflow-interceptors.mjs:398, 414`.

| op | `act` checked | Reusable from history for |
|---|---|---|
| approve | `ref: approvalId, run, decision, argsDigest` | nothing (single pending approval): **sound** |
| report | `ref: orderId` | any outcome and result for that order, while it is open. A retryable failure leaves it open. |
| propose | `ref: action` | the same action with any data, as often as the machine accepts it |
| claim | `ref: orderId` | re-claiming after the lease lapses |
| release | `run` | any snapshot, if the run is poisoned again in the same execution |
| migrate | `ref: from` | any snapshot (MG1) |
| version | (only `op`) | any `decision`, `toBuildId` and `reason` rows in the journal |

**Evidence.** Test PR1. The agent reports a retryable failure with its token. A history reader lifts the token and reports `ok: true, result: { count: 5 }`. The result is accepted, and the run moves to `drafting` with `ticketCount: 5`.

**Fix.**

- Bind the content that makes the action what it is:
  - report: `ok`, `permanent`, `digest(result)`;
  - propose: `digest(data)`;
  - version: `decision`, `toBuildId`;
  - release: `digest(snapshot)`.
- Make tokens single-use: record each consumed `sig` digest in `results`, which is carried across Continue-as-New.
- Correct the SEC-PR1 Response.

### RT1: rotating an approver key out of `principals` wedges the runs it approved

`workflow-interceptors.mjs:398-399`: the approve **handler** calls `verifiedPrincipal` again. The same holds for `resolveActor` in every GovernedWorkflow handler (`:471`, `:513`).

Validators do not run on replay, but handlers do. In SDK 1.24, a non-`TemporalFailure` thrown from an Update handler fails the activation (`@temporalio/workflow/lib/internals.js:737-800`). Replaying a history under a trust store that no longer holds the key throws `refused: the token is signed by 'idp', which this worker does not trust`, and the workflow task fails.

**Evidence.** Test RT1. The same history replays clean under the original trust store (the control), and fails under a rotated one. Revoking an approver's key is the operation an operator does *in a hurry*, and it would wedge every in-flight run that approver touched.

`exp` is not the trigger, because replay uses the recorded workflow time. Only a trust-store change triggers it. A `maxTtlMs` or `audience` change would trigger it too.

**Fix.** Verify in the validator only. The handler must re-derive the principal without re-judging it:

- the validator caches its verdict by Update id, which is safe because the validator and the handler run in the same activation;
- on replay, when `workflowInfo().unsafe.isReplaying` and no cached verdict exists, use the token's claimed `id` and `roles` with `verified: true`, because the Update was accepted, which proves the validator passed at the time.

### SH1: turning sealing on strands continued runs

`workflow-interceptors.mjs:437`:

```js
openHeader(carried, keys, { required: Boolean(config.headerKey), … })
```

A worker that just gained a `headerKey` meets a plaintext head in any execution that a pre-sealing worker continued-as-new into. It throws `the ledger header is not sealed, but this worker requires sealed headers` in `execute`, so the workflow task fails on every replay.

**Evidence.** Test SH1. `postAcrossContinueAsNew` is run unsealed. The continued execution's history replays clean without a key (the control), and fails with one.

P2.6 "must be done before any partner pilot", so every pilot turns it on over existing runs.

**Fix.**

- Add a rollout mode: `headerKey: { …, acceptPlaintextUntil }`, or accept plaintext **heads** only when `continuedFromExecutionRunId`'s start time precedes a configured cutover.
- Require the seal on activity deltas and the exporter only after the cutover.
- Document the order of operations: deploy with the key, drain or cut over, then require it.

### VG1: a pending version move is applied early, on the old version

`governed-workflow.mjs:580-587` and `:567-573`.

The loop wakes on `workflowInfo().continueAsNewSuggested`, and line 587 lets it through to `handOver()` even when the migration is not ready. `handOver()` then does two things wrong:

- it carries `snapshot: pendingMigration ? pendingMigration.snapshot : state`, which is the state computed **for the new version**;
- it continues as new with `makeContinueAsNewFunc({})`, because `upgrade` is false, so it stays pinned to the **old** version.

`pendingMigration` is not carried. So:

- a same-shape migration is silently adopted on v1;
- a shape change is refused by v1's `checkSnapshot`, and the run is quarantined holding `previous`;
- either way, the gate's decision is forgotten, and the wake phase will not find the run.

**Evidence.** Test VG1. The dev server suggests Continue-as-New at 40 events. The run gets `migrate { ticketCount: 7, onVersionChange: true }`, and no version change ever happens. After a few claims, the run has continued as new with `ticketCount: 7` and `migrationPending: null`. In production the default threshold (4K events or 4 MB) is reached by exactly the long-lived runs that wait days for a promotion.

**Fix.** When a migration is pending but not ready:

- continue as new with the **current** state;
- carry `pendingMigration` in the Continue-as-New arguments, which must be accepted only from a Continue-as-New, like the other carried fields, and re-validated against `from`.

### RP: the ramp gate compares kind names, and misses what a run may actually call

`kernel/src/policy-ramp.mjs:28-36`, and `rules.mjs:182` (`allowedNow`).

`allowedNow` returns the declared **kind names** a guard would allow. The gate diffs two such lists, but a run is promised activities, not kind names:

- **RP1.** `slack_send` moves from kind `post` to a new kind `external-post` that needs a manager, while `teams_send` keeps kind `post`. `post` is in both lists, so the result is `move`, and the next `slack_send` is denied.
- **RP2.** `unlabelled: report` → `deny`: an undeclared activity the run uses now is denied after the ramp. `allowedNow` lists declared kinds only, so the result is `move`.
- **RP3** (the plan row). The run has spent 90 of a 100 USD budget, and the new policy caps spend at 50 under a new rule id. The meter starts at 0, `freshRules: ['usd-per-run']` is returned, and the result is `ok: true`. The run may now spend 140 in all under a cap of 50. The row's test, "a tightened budget that a run in flight has already been promised is reported, and the ramp is refused", was replaced by a new `requires-prior` rule in `policy-ramp.test.mjs`.

The brief says such runs are "named and **pinned**". `PolyflowPolicyGateWorkflow` has no apply phase. It throws `PolyflowGateRefused`, and nothing pins a G1 run to the old policy's workers. That is left to the operator's Worker Versioning setup, which no test exercises.

**Fix.**

- Vet by activity type: for each activity either policy declares, and for the `unlabelled` fall-through, compare `decide` under old and new.
- Map meters of renamed rules by structure (same kinds and metric), or refuse a ramp with a fresh counting rule unless `allowFresh` is given.
- Write the plan row's test.
- Either add an apply phase that records `pin` on each run (a signal, as the G2 gate does), or change the brief to say "named, and the ramp refused".

### GF: the ramp gate fails open

`gate-activities.mjs:80-84`.

- **GF1.** `catch { continue; } // not governed`. A running governed workflow whose query fails is skipped, and the query fails when no worker polls, which is what a worker roll looks like.
- **GF2.** `if (g?.policy !== before.digest) continue` drops runs under any other policy, and `vetPolicyChange` of an empty fleet is `ok: true`. A wrong `oldPolicy`, or a fleet already half ramped, passes with nothing vetted.

The same query, with no filter, also queries **every** running workflow in the namespace. Each query is a billed Action (see NFR).

**Fix.**

- A query failure on a run whose type or memo marks it governed is a `pin` with the reason "unreadable".
- Count runs under other policies and report them.
- Refuse an empty vetted fleet unless `allowEmptyFleet`, as `PolyflowGateWorkflow` does.
- Scope the list by default to workflows that carry a governed marker (a search attribute).

### WT1: "every wait has an exit" is checked per state, not per order outcome

`kernel/src/explore.mjs:174`. A non-terminal state is `stranded` only if **none** of the completion actions of the orders that led into it is accepted.

customer-brief's `posting` waits on `post_brief`, whose outcomes are `POST_DONE` (success) and `POST_FAILED` (failure and exhausted). Make `posting` refuse `POST_FAILED` and the check still passes, because `POST_DONE` is accepted. `every-state-can-finish` passes too.

**Evidence.** Test WT1. The machine is certified. At run time a post that fails five times gives `POST_FAILED`, which is rejected. The order is closed as exhausted, and the run sits in `posting` for ever. `posting` is declared unstoppable, so STOP is refused.

The brief's "every wait has an exit somebody actually sends" is exactly the claim this breaks.

**Fix.**

- For each edge into a state, and each order kind the edge issued, require each declared outcome hook's action to be accepted in the target state, or a timer armed on that edge to be accepted.
- Compute the check per incoming edge, not over the union of edges.

### DEP: the admission package rule is bypassed by two spellings

`cli/src/admit.mjs:225` matches `/require\(\s*['"]([^'"]+)['"]\s*\)/`. `temporal/src/certificates.mjs:43-46` accepts `` `…` `` without `${}` as a literal, and allows whitespace before `(`. Neither `` require(`node:path`) `` (DEP1) nor `require ('node:path')` (DEP2) is refused, and both machines are certified. DEP0, the quoted form, is refused, as the control shows.

webpack bundles both spellings. A package required this way (anything under `node_modules`) runs under the certificate, and its code is not in the certificate's module list.

**Fix.** Use one scanner for both checks: the certificate's literal check, which yields the argument, then the package rule applied to what it yields. Or better, reuse webpack's module graph (the SEC-CT1 deferral).

### QJ: the QuickJS host and the TS host disagree on certified machines

`python/polyflow_temporal/machine_host.py:65, 164-166, 329`.

- **QJ1.** `_REQUIRE` matches quotes only. A machine that requires sam-pattern through a template literal is certified in TS (SEC-CT1 accepts it) and steps in the TS host. The QuickJS bundle has no mapping for it, so the result is `MachineLoadError: require('@cognitive-fab/sam-pattern') is not in the bundle`.
- **QJ2.** The prelude makes `Date.now()` throw. In the TS isolate, `Date.now()` is workflow time and deterministic. Admission explores in Node, where it works, so a machine that reads the clock is certified; this was confirmed with `admit()`. TS steps START `accepted`. In QuickJS sam-pattern swallows the throw, and START is `unhandled` ("no acceptor handled 'START'"), silently: no poison, and no error.
- **QJ3.** `_RESOURCE.search(value["poisoned"])` turns any poison whose **text** contains "interrupted", "stack overflow" or "out of memory" into `MachineBudgetExceeded`. A mapper throwing `ticket feed interrupted` is quarantined by TS, and in Python it is a workflow-task failure, retried for ever.

The corpus (`machine.json`, 356 operations) has no machine that throws, reads the clock or requires through a template literal, so conformance did not see any of this.

**Fix.**

- Parse requires with the same scanner as the certificate.
- Either refuse clock and randomness reads at **admission** (so the certificate means the same thing in both hosts), or give QuickJS workflow time as `Date.now`.
- Classify budget failures by engine signal (trap kind, the interrupt handler firing), never by message text.
- Add these three machines to the conformance corpus.

### NFR: NFR-13 counts the wrong Actions and measures the wrong bytes

`temporal/test/acceptance.test.mjs`. Per Temporal Cloud's Actions page (docs.temporal.io/cloud/actions, read 2026-09-22):

| Item | The test says | Temporal Cloud |
|---|---|---|
| memo upsert (`workflowPropertiesModified`) | +1 Action | **not billed** (only search-attribute upserts are) |
| Queries | "not billed" | **billed**: "An Action occurs for every Query" |
| Updates | only accepted ones, counted from history | **accepted and rejected** are billed. Rejected ones leave no history. |

Consequences:

- **The memo decision was driven by a miscount.** External feedback 1's "the default is 9.1%" (memo on) and the switch to opt-in were driven by it. With the memo on, the cost is +1 Action per execution, not +2.
- **The product's own queries are billed and not counted.** The G2 gate queries every governed run twice per ramp (fleet, then wake). The G1 gate queries every running workflow its filter matches, and with no filter that is the whole namespace. The approvals inbox and the gateway poll `polyflow.pending` and `polyflow.state`.
- **Rejected Updates are billed.** 25 of the DST's 92 stimuli were rejected by validators: billed, and invisible to `actions()`.

History bytes are `JSON.stringify(history).length`. `fetchHistory()` returns protobuf objects whose payload `data` are `Uint8Array`s, and those serialise as `{"0":…,"1":…}` at about 3–8 characters per byte. Measured on the same 10-step loop:

| | JSON (the harness) | protobuf (`History.encode`) |
|---|---|---|
| baseline | 60,222 | **18,893** |
| governed | 118,883 | **61,526** (3.26×) |
| governed + sealed (P2.6) | 143,132 | **79,699** (4.22×) |
| per activity, added | "5,437" | **1,937** (2,764 sealed) |

The brief's "roughly double … about 5 KB per activity" is wrong in both directions. Against the 50 MB history limit, sealed governance cuts an agent loop's activity budget by about 4×. That is the number an acquirer's Cloud team will compute.

**Fix.**

- Count with Cloud's table: drop the memo, and add the gate's and gateway's queries per run as a separate line.
- Measure rejected Updates in the DST and gateway paths from the client side.
- Measure bytes with `History.encode(h).finish().length`, and report the sealed configuration, because it is the pilot default.
- Correct the plan's Status row and the brief.

### PK: the pass^k table measures the PRNG

`temporal/test/passk.test.mjs`, `fixtures/passk-workflows.mjs`.

The agent draws `early`, `skip` and `again` from `prng(1000·t + k)`, in a fixed order, whatever happens to its calls. The outcome is therefore determined without running anything:

- **plain** is ok iff ¬early ∧ ¬skip ∧ ¬again;
- **governed** is ok iff ¬skip, because the policy denies exactly `early` and `again`, and `skip` becomes "missed".

Recomputed from the PRNG alone, with no Temporal and no plugin, the table is `plain {0.5, 0, 16, 0}` and `governed {0.81, 0.63, 0, 6}`: **identical** to the brief.

What this means for the table:

- **"0 unsafe" is true by construction.** The policy's two rules are the success criterion.
- **There is one task.** The 8 "tasks" are the same task with 8 seeds, so pass^k here is just p^4 estimated from 8 samples.
- **Plain pass^4 = 0.00 is sampling noise.** The expectation is (0.85·0.9·0.8)^4 = 0.14. Over 2,000 seeded tasks the probe gives 0.15 plain and 0.68 governed, and the probability of seeing 0 of 8 is about 0.30.

The arms **are** fair to each other: identical seeds and identical PRNG consumption, whatever the guard does. That holds up. What the harness shows is that the guard enforces its two rules, which unit tests already show.

**Fix.**

- Present it as a demonstration, not a measurement. In the brief, "the same scripted stochastic agent" should say "the pass^k of a script whose mistakes the policy names, by construction".
- Report expectations with confidence intervals.
- Or make it a measurement: include mistakes the policy does *not* name, and distinct tasks.

### BR: claims in the acquisition brief the code does not support

| Brief | What is true | Finding |
|---|---|---|
| "It uses GA seams only: plugins, interceptors, Updates, Worker Versioning and the Replayer." | In `@temporalio/worker` 1.24.0, `WorkerPlugin` is marked "`@experimental` Plugins is an experimental feature" (`worker/lib/worker-options.d.ts:760`). `targetWorkerDeploymentVersionChanged` and `initialVersioningBehavior` are "`@experimental` Upgrade-on-Continue-as-New is experimental" (`workflow/lib/interfaces.d.ts:102, 347`). D5's whole wake phase rests on the second. | this section |
| "An escalation parks the exact call. The approver sees its arguments and approves those." | The call is parked by reference. | AP1 |
| "Liveness. Every state can finish, and every wait has an exit somebody actually sends." | Only one outcome per wait is checked. | WT1 |
| "Any run the new policy would deny an effect it is allowed now is named and pinned." | Kinds, not effects. Undeclared effects are ignored. It fails open. Nothing pins. | RP, GF |
| "A run never replays across versions. The migration is refused if it was computed from a state the run has since left." | A migration is applied on the old version when Continue-as-New is suggested. An identity migration's `from` stays valid for anyone who reads history. | VG1, MG1 |
| DST: "claims by two agents"; "stale migrations"; "one hash chain covers every execution"; "the journal's accepted steps are exactly what the machine accepts". | The claims are sequential. `stale` is always a digest mismatch. Seed 9 forks. I5 is a subset check on the last execution. | DST, DS2 |
| pass^k table | A closed-form function of the seeds. | PK |
| "Cost. One billable Action per execution … under 10% from 11 Actions." | True for the flush on this loop. The memo is counted, and the queries and rejected Updates the product issues are not. | NFR |
| "History size … roughly double … about 5 KB per activity measured as JSON." | 3.3× (4.2× sealed), about 1.9 KB (2.8 KB) as stored. | NFR |
| "With a trust store, the approver's identity is a signed token the workflow verifies itself." | True. It is also verified again on replay. | RT1 |
| "All of them are fixed or explicitly deferred with a plan row." | P2–P3 also "narrowed". | BR2 |

What checks out in the brief:

- The review counts. 12 blockers and 59 majors match the four summaries: 4+2+4+2 and 12+14+15+18.
- The 4.5% and the break-even at 11, as arithmetic.
- The S2 sample's claims: `test_s2_openai_agents.py` passes, with routed names, the denial rules, and verification under the TS CLI.
- The versioning test's evidence that the next execution reports v2's build id and v2's certificate.

---

## Minor

- **RP4: `freshRules` names the wrong rules** (`policy-ramp.mjs:28`).
  - `at-most` reads `s.n[kind]` and is never fresh.
  - `requires-prior` with `consume` (the default, `policy.mjs:95`) reads `s.credits[r.id]` and is always fresh, so a run that already asked is pinned for want of a credit it earned under another rule name.
  - Test RP4.
- **TK1: tokens are reusable within their life.** `release` binds `run` but not the snapshot. `claim` binds only the order. There is no single-use record for any op. See PR1's table. Fix with PR1.
- **DS2: schedule quality.**
  - `stale` builds `from` from `ticketCount: 98`, which never matches, so it only tests `from !== digest(state)`, never a decision computed from a state the run really held and then left.
  - `try { s = await h.query(...) } catch { break; }` ends a schedule silently.
  - I4 replays whatever visibility lists, with no count.
- **VT1: gaps in `versioning.test.mjs`.**
  - The "not moved before promotion" check waits 1 s.
  - `now?.version?.split('.').pop()` breaks on a build id with a dot. The certified build ids have none today.
  - No test runs `PolyflowGateWorkflow` with `gate.principalKey`, so the signed-migrate path SEC-MG1 added is unexercised end to end.
- **SH2: in-flight plaintext deltas after enabling sealing.** Activities scheduled by pre-rollout workflow tasks, and delivered afterwards, carry plaintext. With keys configured the exporter refuses them (SEC-EX2), so they become ledger gaps with no alert beyond `onError`.
- **WT2: `order-waits-have-deadlines` is a warning.** With `externalMode: 'always'`, a machine whose order waits arm no deadline only `console.warn`s at worker start (`plugin.mjs`). customer-brief's gathering, drafting and posting have none, and the DST runs exactly that configuration. The brief does not say external-mode liveness depends on the agent reporting.
- **QJ4: poison reasons differ.** `TypeError` messages differ between V8 and QuickJS, for example "Cannot read properties of null (reading 'x')" against "cannot read property 'x' of null". The poison reason written to the journal and ledger then differs between hosts. It is harmless for replay, because each host replays its own, but the ledgers are not comparable across languages.
- **BR2: "fixed or deferred" misses "narrowed".** The brief's claim leaves out the P2–P3 dispositions marked "narrowed" (B1 and others), where the spec was changed to match the code.

## Nits

- **N1:** `acceptance.test.mjs` prints "queries (not billed)", which is wrong.
- **N2:** the DST's `posted` summary counts final states, not `post_brief` effects.
- **N3:** the header comment "a failing seed is a reproduction" should add "while the system under test is deterministic". HO1's fork depends on the workflow task in which the update arrives relative to the flush.

## Test gaps (claims without a test)

- **P4.6's row:** "a tightened budget … is reported, and the ramp is refused". Not written; RP3 is the closest.
- **P5.6's row:** "a model rewrite after pre-approval needs a new approval; the approved call executes unchanged". Only the `seen` digest mismatch is tested (`guard.test.mjs:85-88`). AP1 is the missing half.
- **P2.6 and Continue-as-New under rotation:** `headerKeys` exists for rotation, and no test continues a run across a key change, or across enabling sealing (SH1).
- **P5.5 under replay:** no test replays a history with principals after any config change (RT1).
- **The G2 gate with `gate.principalKey`** (VT1).
- **Concurrent Updates** in one workflow task, anywhere in the suite.

## What held up

- **The pass^k arms are fair.** The PRNG is consumed identically whatever the guard decides, so both arms face the same mistakes.
- **The versioning test's end state is real.** `describe().raw.workflowExecutionInfo.versioningInfo` reports v2's build id, the state query is answered by v2's certificate, and v2's `CANCEL` is accepted on a run started under v1.
- **Sealing is sound as a cipher construction.** The SIV nonce covers the context and the plaintext, the context is in the AAD, and opening checks the run and the purpose. Replay produces the same bytes. The P2.6 test checks every activity header, and none holds ledger plaintext.
- **Approve tokens are properly single-purpose:** run, approval id, decision and args digest, verified in the validator.
- **The S2 sample** runs an unmodified `SupportAgent` with a scripted model, classifies the MCP activity by routed tool name, denies the second refund with both rules, and its ledger verifies under the TypeScript CLI (194/194 Python tests in the two files).
- **The QuickJS sandbox claims:** the conformance corpus passes on both engines and both hashing modes. No host objects, no clock or entropy below JS, and fuel, memory and stack limits all recover.
- **The ramp kernel is pure and deterministic**, and it pins correctly when a counter the run already used is tightened under the **same** rule id (a metered budget at 60 of a new 50 is pinned).
- **The DST's replay step** (I4) replays every listed execution under `maxCachedWorkflows: 0` with the plugin, and found no non-determinism error. What it does not check is the ledger, which is not a command.

## Status table: what the rows should say

| Row | Suggested wording |
|---|---|
| P2 / 2.6 | Sealed headers built. **Enabling sealing on a fleet with continued runs is not yet rollout-safe (SH1).** |
| P3 / 3.4 | Continue-as-New hand-over built. **An Update accepted during the hand-over flush is lost (HO1): open.** |
| P4 / 4.6 | Policy ramp gate built as a **kind-level, fail-open** check (RP, GF). The plan row's test (tightened budget) is not written. |
| P5 / 5.5–5.6 | Principals built. Approve tokens are single-purpose. **Report, propose and migrate tokens are not (PR1, MG1).** **Frozen arguments not built (AP1).** |
| P7 / 7.4 | QuickJS evaluator built. **Not semantically identical to the TS host on certified machines (QJ).** |
| P9 | DST built. **It does not detect forks or lost Updates (DST).** pass^k is a demonstration (PK). NFR-13 must be re-measured with Cloud's Action table and protobuf bytes (NFR). |

---

## Response

All three blockers are fixed, and so are 12 of the 13 majors. The last major is the defect the DST test found, which is **open** (DST1-R, below). Each fixed finding's test now passes. Where a test had to mint tokens in the new action-bound form, or expect activity names instead of kind names, the change says so in the test.

| Suite | Result |
|---|---|
| kernel | 82/82 (RP1–RP4) |
| cli | 31/31 (WT1, DEP1, DEP2) |
| temporal | HO1, AP1, PR1, MG1, RT1, SH1, VG1, GF1–GF3 pass. DST1 runs as a visible `todo`. |
| gateway / service | 12/12, 21/21 |
| python | 463 passed (QJ1–QJ3) |

| # | Outcome | What changed |
|---|---|---|
| HO1 | fixed | From the start of a hand-over, every Update validator refuses with a retryable reason (`retry: the run is handing over…`). A Signal is held and carried. What the next execution starts from is computed **inside** the Continue-as-New interceptor, after the closing flush, in the activation that emits the command. Orders called off at the hand-over stay open and are carried, and no new order is started in the old execution. The test's report now retries on that reason, as any client does, and lands on the next execution. |
| AP1 | fixed | An escalated call's arguments are **frozen** (a deep copy) when it parks. The approver is shown the copy, and the copy is what runs. |
| MG1 | fixed | A migrate token binds `{ op, wf, run, ref: from, to: digest(snapshot) }`. A token lifted from history can only re-do the migration it already recorded. The gate signs for the current run and the exact target. `release` binds the run and the target the same way (TK1). |
| PR1 | fixed | A report token binds the order's **attempt** and the digest of the outcome `{ ok, result, error, permanent }`. A propose token binds the digest of its data. Propose by Signal is refused when principals are configured: the Update carries a validator. The gateway mints the new form. |
| RT1 | fixed | Update handlers take the token's claims (`principalClaims`) without verifying again. The validator verified at acceptance, and a handler that re-verifies on replay would fail after a key rotation. |
| SH1 | fixed | A plaintext Continue-as-New **head** is accepted, so turning sealing on does not strand chains that continued before it. A head is only read across a real Continue-as-New, and the seal protects its confidentiality, not its origin. Ledger **deltas** still require the seal when keys are configured (SEC-EX2). **Deferred:** SH2, an opt-in rollout window for deltas that pre-rollout code still sends. |
| VG1 | fixed | If Continue-as-New is suggested while a run waits for promotion, the run carries its current state and the pending migration (`migration` is a carry field) and keeps waiting on its own version. A migration whose `from` no longer matches the state is dropped at the hand-over, the drop is journaled, and the gate re-vets. |
| DST | fixed in part | The harness states its scope plainly: sequential stimuli, I1 and I5 on the last execution, and I3 on the sink. HO1, the lost Update, is fixed. **Open (DST1-R):** the fork that remains is a different defect. The ledger event **times of a run's first activation** differ between two replays of the same history: `at` is the first task's time in one and the second task's in the other. The exported flush and the Continue-as-New head are built in different replays, so the head handed over does not match the exported chain. This was reproduced and pinned to the time field of the first order's events. `review-p9-dst.test.mjs` keeps it visible as a `todo`. **Next step:** take event times from a replay-stable source (for example, derive `at` from the history's own event time for the activation), and assert exporter conflicts inside `dst.test.mjs`. |
| RP1–RP4 | fixed | The gate compares **activities** under each policy, including undeclared ones. It carries the run's counters into the new policy: a renamed budget over the same metric starts from what was already spent, as does a renamed rate. `freshRules` lists exactly the counters that start from zero: a new consuming requires-prior, or a budget over a new metric. |
| GF1/GF2 | fixed | A run whose guard cannot be read fails the gate (`unread`). Runs under another policy digest are listed (`otherPolicy`). An empty vetted fleet is refused unless `allowEmptyFleet`. "Pinned" now means the gate refuses the ramp; keeping runs on old workers is the operator's Worker Versioning step, and the brief says so. |
| WT1 | fixed | `every-wait-has-an-exit` requires each **outcome** of every order open in a state (success, failure, exhausted) to be accepted there. It found a real gap in our own example: customer-brief's `drafting` refused `TICKETS_FAILED`, the wiring of `draft_brief`'s failure. That is fixed in v1 and v2. |
| DEP1/DEP2 | fixed | The module rule matches every spelling: quotes or a template literal, spaces before the parenthesis, `require()`, `import()`, and ESM `import … from`. |
| QJ1–QJ3 | fixed | **QJ1:** the QuickJS bundler uses the certificate's literal rule. **QJ2:** `Date.now()` is workflow time, as in the TypeScript isolate. **QJ3:** budget exhaustion is decided by the engine's signal, never by message text. The corpus is at 512 operations, with three new fixture machines. **Open decision:** reads of the clock and of randomness should arguably be refused at admission in both hosts (see the spike document). |
| NFR | fixed | Actions are counted per docs.temporal.io/cloud/actions (checked for this response): a memo upsert is **not** billed, and queries and rejected Updates are, though governance adds none to the loop. History is measured as protobuf: **3.3×** the baseline, and **4.2×** sealed. N1 is fixed. |
| PK | fixed in the claim | The test header and the brief now say what the table is: one task, seeded trials, and "0 unsafe" as the policy's purpose, enforced end to end. They also give the plain arm's expectation. |
| BR, BR2 | fixed | The brief names the two `@experimental` seams and describes frozen calls, per-outcome liveness, and the gate's semantics exactly. It states the DST's scope and the open DST1-R. Review outcomes are described as fixed, narrowed or deferred. |
| TK1 | fixed in part | `release` is bound (above). **Deferred:** `claim` binding the lease, and single-use `jti` records. |
| DS2, VT1, WT2, QJ4, N2, N3 | deferred / fixed | N3 is fixed in the DST header. **Deferred:** DS2, the DST's stale-move realism and I4 count; VT1, versioning-test hardening and a signed-gate Temporal test; WT2, making `order-waits-have-deadlines` a refusal under `externalMode: 'always'`; QJ4, V8 and QuickJS error wording in poison reasons. |
