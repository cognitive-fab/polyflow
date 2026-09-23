# Review: P2 (G1 Guard) and P3 (G2 Govern)

This is an adversarial review of the guard and governed-workflow surface:

- `platform/packages/kernel/src/{policy,rules,admit-policy,machine-host,key}.mjs`
- `platform/packages/temporal/src/{workflow-interceptors,guard-governor,governed-workflow,client,plugin}.mjs`

It checks the code against the functional spec (FR-GRD, FR-GOV, FR-HUM.3), the
technical spec (§3.4, §4.1–4.3, §5.2, §5.4, §6.3) and the P2/P3 rows of the
implementation plan. The reference semantics for the machine host are
polyrun's `kernel.mjs` and `workers.mjs`. The reviewer did not write the code
and changed no production code.

## How to reproduce

Each failing test asserts the behaviour the spec claims, so each one **fails
today**. They sit next to the suites they break. Until the findings are fixed,
or the tests are removed, `npm test` in `kernel` and in `temporal` goes red.

| File | Tests | Needs server |
|---|---|---|
| `platform/packages/kernel/test/review-p2p3-kernel.test.mjs` | G2, G3, G4, G5, G6, A1, K1, H2, H3 | no (A1 takes about 16 s) |
| `platform/packages/temporal/test/review-p2p3-temporal.test.mjs` | G1, G7, G8, C1, S1, S2, P1, P2, T1 | yes (about 20 s) |
| `platform/packages/temporal/test/fixtures/review-p2p3-workflows.mjs` | fixture workflows | – |
| `platform/packages/temporal/test/fixtures/review-p2p3-machine/` | the `review-probe` machine: work, deadline timer, a terminal `notify`, and a `BOOM` action that poisons | – |

```
cd platform/packages/kernel   && node --no-warnings --test test/review-p2p3-*.test.mjs
cd platform/packages/temporal && node --no-warnings --test --test-concurrency=1 test/review-p2p3-*.test.mjs
```

Baseline at review time: kernel 51/51 green, and temporal `guard` + `governed`
16/16 green. All 18 review tests fail, each for the reason its message gives.
Every temporal review test that parks an activity releases it in a `finally`,
and terminates any run it leaves open.

---

## Summary

| # | Severity | Finding | Evidence |
|---|---|---|---|
| S2 | **blocker** | Anyone who can start a workflow can start `GovernedWorkflow` with a `snapshot`, which puts a certified machine into any state it likes. A forged `review` snapshot plus one `APPROVED` posts the brief, and no approval was ever requested. | S2 |
| S1 | **blocker** | The `propose` Update and Signal accept any action the machine would accept, including the completion of an open order. The agent (or anyone with Update access) can answer the human's approval order itself, and the brief is posted. | S1 |
| G1 | major | External-workflow signals (and Nexus operations) are not intercepted. FR-GRD.1 "every effect crosses the guard" does not hold: with `unlabelled: "deny"`, a signal to another workflow goes out with no proposal and no verdict. | G1 |
| G2 | major | An `unlabelled: "escalate"` effect can never be approved. The unlabelled branch returns before approvals are consulted, so a human's *approve* becomes a denial. | G2 |
| G3 | major | Approvals are bound to (kind, argsDigest), not to the proposal. An approval whose effect was then denied stays unconsumed. A later, different proposal with the same arguments uses it, and no human is asked (FR-HUM.3). | G3 |
| G5 | major | Unlabelled effects (the default `report` mode) skip every budget. A `tool-calls` budget counts them but never stops them. | G5 |
| G7 | major | A local activity retried after a timer backoff re-enters the interceptor as a new effect. `at-most-1` denies the retry, and a per-effect approval would be asked for again. The P1 deferral of M2 said this does not affect correctness; under the guard, it does. | G7 |
| B1 | major | FR-GRD.7 "retry storms stop at the budget" is not implementable as built. Server-side activity retries never cross the guard. Failed calls are never metered. No FR-GRD.7 fixture exists on Temporal. | code |
| A1 | major | The admission reachability search is exponential in the number of kinds whenever any kind is unreachable, including a legitimate `forbid: true`. 11 kinds take 16 s, 12 kinds take 55 s, and 15 would take hours. It runs synchronously in the `PolyflowPlugin` constructor. | A1 |
| AP1 | major | Approvals are unauthenticated. Any Update caller approves as any principal, and neither the escalation role nor four-eyes is checked. The code records `verified: false`, but no spec section or plan row defers this. | code |
| P1 | major | While a run is poisoned, order completions and timer firings are dropped: not journaled, not remembered, not replayed after release. A released run then waits forever for work that already finished. | P1 |
| P2 | major | `polyflow.release` accepts any object as the new state. It is not checked against the contract, not journaled, and not attributed. It re-arms no timers, and STOP is impossible while the run is poisoned. | P2 |
| T1 | major | Effects emitted on the step that reaches a terminal state are cancelled in the same step, before they run. polyrun executes them. | T1 |
| H2 | major | A permanent failure (including a guard `PolyflowDenied`) on an effect whose manifest has `onExhausted` but no `onFailure` is dropped. The machine never hears of it. polyrun falls through to `onExhausted`. | H2 |
| CN1 | major | Continue-as-New can never happen in a waiting state: it requires `timers.size === 0`, and every waiting state arms a timer (FR-GOV.8). The dedupe table is not carried. The "1,500 updates" trigger is not implemented. P3.4 has no test. | code |
| C1 | major | `startGoverned` spreads caller `options` after the derived `workflowId` and reuse policies. A caller can run the machine under any id and defeat FR-GOV.5, while the function reports the derived id. | C1 |
| G8 | minor | An escalation whose effect is cancelled (by a `CancellationScope`, a terminal governed step, or workflow cancel) stays in `polyflow.pending` forever. It can still be "approved", and that approval is recorded as a human proposal. | G8 |
| G4 | minor | A metered budget adds whatever number the result carries: a negative reading refunds the budget. | G4 |
| G6 | minor | A declassification step scheduled *before* the reads, but completing after them, declassifies data it never saw. | G6 |
| G9 | minor | A failed `reads-untrusted` effect does not taint, but its error text still reaches the agent. | code |
| K1 | minor | `deriveKey` uses `replaceAll` with the raw value, so `$`-patterns are interpreted (`a$$b` and `a$b` collide) and values are re-scanned for later placeholders. `polyflow/<machine>/<key>` collides across machines when names or keys contain `/`. | K1 |
| H3 | minor | A scalar activity result becomes `{ value }`. polyrun passes `{}`, so a strict action schema can reject a completion that polyrun accepts. | H3 |
| V1 | minor | The Update validator's dry run skips the mapper. An Update can be accepted and then poison the run in its handler. | P1 fixture |
| D1 | minor | Dedupe returns the cached result for an actionId reused with a *different* action. polyrun throws `ConflictError`. | code |
| Q1 | minor | The `polyflow.journal` and `polyflow.state` queries return raw proposal data, order payloads and full pre/post states, none of it redacted. The ledger itself is redacted. | code |
| M1 | minor | Unbounded growth: `orders` is never pruned. The journal keeps 500 full pre/post states in memory, and a Query response over the size limit fails. | code |
| C2 | minor | `startGoverned`: a describe-then-start race misreports `started`/`attached`. A FAILED or TERMINATED run is reported as `complete` ("do NOT start another run"). The spec says signal-with-start or update-with-start. | code |
| C3 | minor | Intent (order) ids use the workflowId, not the runId, so a reset or reused id reproduces the same orderIds. | code |
| SP | minor | Spec and code mismatches (see the list below). The spec's own §3.4 example policy is refused by `admitPolicy`. | repro |
| TG | minor | Plan rows claimed without a test: P2.4 CapLease on Temporal (only approve, reject and timeout run there), P2.5 budgets, P3.4 CaN, P3.5 poison and release, governed timers, FR-GRD.8 "1,000 replays". | tests |
| N* | nit | See the nits section. | – |

---

## Blockers

### S2: A governed run can be started inside any state

`governed-workflow.mjs:66,78,228`: `GovernedWorkflow({ machine, input, snapshot, seq })`
takes `snapshot` straight from the start arguments. When it is present, the
workflow skips the input action and uses it as `state`. Nothing checks that
the run is a Continue-as-New, that the snapshot has the contract's keys, or
that the state is reachable.

Test **S2** starts `GovernedWorkflow` directly with
`{ briefState: 'review', ticketCount: 3, reason: '' }` and proposes `APPROVED`.
The run ends `posted`. Its history contains `post_brief` and never
`request_approval`.

This is the same class of hole the P0/P1 review closed for the ledger head
(M4): state handed over by CaN is accepted from any client that starts a run.
Every guarantee on the certificate ("no post without prior approval", say) is
a statement about reachable states. A snapshot start lets a client skip
reachability entirely.

**Fix.**
- Accept `snapshot` and `seq` only when `workflowInfo().continuedFromExecutionRunId`
  is set. Otherwise refuse with `PolyflowSnapshotRefused`.
- For migration, route through `polyflow.release` (see P2), which must validate.
- Also validate a CaN snapshot: rehydrate it through the host and require
  exactly the contract's keys.

### S1: The agent can answer the human's order

`governed-workflow.mjs:200-213`: the `propose` Update (validator = `host.dryRun`)
and the `propose` Signal step **any** action. The machine cannot distinguish
`APPROVED` delivered as the completion of the open `request_approval` order
(performer: human) from `APPROVED` sent by whoever holds a Temporal client.

Test **S1** parks `request_approval`, then sends `polyflow.propose { action: 'APPROVED' }`.
The Update is accepted and `post_brief` runs. The human never answered; their
order is then cancelled at the terminal step.

FR-HUM.2's claim protocol ("only the holder may report") is scheduled for P5.
G2 ships the propose path now, however, and polyflow's six-tool loop is exactly
an agent that holds it. Until claims exist, G2's "the machine decides what
happens next" does not hold for any machine that waits on a human.

**Fix (minimum for G2).**
- An action that is the `onSuccess`, `onFailure` or `onExhausted` target of a
  manifest effect is a *completion action*. On the propose path, accept it only
  with `orderId` set to an **open** order of that kind, and mark the order
  closed.
- Reject a bare completion action with "completions are reported against their
  order".
- Record the proposer (see AP1).
- When P5 lands, the order's role check replaces the orderId check.

---

## Major

### G1: External signals and Nexus operations bypass the guard

`workflow-interceptors.mjs:250-270`: the outbound interceptor implements
`scheduleActivity`, `scheduleLocalActivity`, `startChildWorkflowExecution` and
`continueAsNew`. The TS SDK routes `getExternalWorkflowHandle().signal()` and
child `signal()` through the outbound `signalWorkflow` hook
(`@temporalio/workflow/lib/workflow.js:589,675`), and Nexus through
`startNexusOperation` (`nexus.js:37`). Neither hook is implemented.

Test **G1** runs a policy with `unlabelled: "deny"`. A workflow signals another
workflow, the signal is delivered, and the signaller's ledger holds no proposal
and no verdict.

FR-GRD.1 and tech spec §5.2 both list these effects explicitly. One workflow
signalling another that performs the post is an obvious way around a policy.

**Fix.** Implement `signalWorkflow` and `startNexusOperation` through
`governed()`. Classify them by signal name or by operation, falling back to
`unlabelled`.

### G2: `unlabelled: "escalate"` can never be approved

`rules.mjs:128-135`: `decideInner` returns early for undeclared candidates and
never reaches `approvalFor`. `governed()` grants the approval and re-decides,
gets `escalate` again, and throws a denial at `workflow-interceptors.mjs:204`.

Test **G2**: after `grant` for the exact kind and digest, `decide` is still
`escalate`. On Temporal, every unlabelled effect waits for a human, and a
"yes" becomes a deny.

**Fix.** In the unlabelled branch with `escalate`, return `allow` with
`approval: a.id` when `approvalFor(s, c)` matches.

### G3: Approvals outlive the proposal they were granted for

`rules.mjs:57,145-148` binds an approval to `(kind, argsDigest)`. Tech spec
§6.3 and FR-HUM.3 bind it to *(kind, argument digest, run, step)*. The two
differ whenever the re-decide after a grant is a deny.

`workflow-interceptors.mjs:201-205` grants the approval, re-decides, and if the
result is a deny, throws. The approval stays in state, unconsumed, for the rest
of the run (and past CaN, if guard state is ever carried). Deny paths include:
a concurrent sibling committing first (at-most, rate, budget), a `never-after`
signal arriving while parked, or a budget crossing.

Test **G3** runs two emails escalated together. `y` is approved and sent. `x`
is approved but rate-denied. A minute later the agent re-proposes `x` and it
is **allowed with the stale approval**; nobody is asked.

**Fix.** Put `proposal: pid` on the approval when it is granted. `approvalFor`
matches `proposal` too, or `governed()` passes the approval id explicitly so
that only that approval can satisfy the decision. On any deny after a grant,
mark the approval `void` in state.

### G5: Unlabelled effects are outside every budget

`rules.mjs:129`: `report` returns `allow` before any rule, budgets included.
`commit` does meter them (`rules.mjs:176`), so the meter reads 4 of 2 while the
calls keep flowing (test **G5**). A policy that lists five tools and caps tool
calls at 400 does not cap the other MCP tools the agent has.

**Fix.** In the unlabelled path, evaluate budgets whose `kinds` is null, and
decide deny or escalate on them the same way as for declared kinds.

### G7: Local-activity retries are new effects to the guard

In TS SDK 1.24, `scheduleLocalActivity` (`workflow.js:300-335`) loops on
`LocalActivityDoBackoff`: it sleeps, then calls the composed interceptor again
with `attempt` incremented. `governed()` ignores `input.attempt`, so each
backoff attempt is a new proposal, verdict and commit.

Test **G7** runs a local activity that fails once. Its retry is denied by
`at-most-one-post`: `"failed: at-most-one-post … it has happened 1"`. Under a
per-effect rule, the human would be asked again, which contradicts §6.3 ("a
retry by Temporal is not a new effect").

The P0/P1 response deferred M2 because it "does not affect correctness". Under
G1 it does.

**Fix.**
- When `via === 'local-activity' && input.attempt > 1`, it is the same effect.
- Skip decide and commit, append an `observation`-only record with the attempt
  number, and reuse the first attempt's `eid`.
- Key the effect on `(seq of first attempt)` and carry it in
  `originalScheduleTime`/`attempt`.

### B1: Budgets cannot stop retry storms, and failures are not metered

FR-GRD.7 says budgets are enforced "by the guard, not by retry configuration"
and that "retry storms against a rate-limited model stop at the budget".

- A scheduled activity is decided **once**. Temporal's server retries it per
  the retry policy, whose default is unlimited attempts, and the guard never
  sees those retries.
- `observe` meters only `ok` results (`rules.mjs:188`). A 429 with a usage body
  costs nothing.

The kernel tests cover budgets over decide/commit sequences. No Temporal test
exercises FR-GRD.7, although P2.5 lists "fixtures from FR-GRD.6 and .7".

**Fix.** One of two:
- Enforce: the interceptor caps `input.options.retry.maximumAttempts` for
  metered kinds, from the remaining budget, and records that it did.
- Narrow the claim in FR-GRD.7 to what the guard can see.

Either way, meter failed observations when the error details carry the metered
field, and add a Temporal fixture.

### A1: Admission is exponential in the number of kinds

`admit-policy.mjs:171-206` runs a BFS over guard states. It stops early only
when **every** kind has been reached. A single unreachable kind makes it
explore the whole state space to depth `k+2`:

- A legitimate `forbid: true`, or any genuinely unreachable kind, is enough.
- The states are count vectors capped at `cap`, which is 2 with an `n: 0` rule.
  That is up to 3^k states, each cloned through `JSON.parse(JSON.stringify())`
  per kind.

Measured with one `forbid: true` kind:

| Kinds | Time |
|---|---|
| 6 | 26 ms |
| 8 | 242 ms |
| 10 | 3.3 s |
| 11 | 11–16 s |
| 12 | 55 s |

Test **A1** asserts under 2 s at 11 kinds. A rule with a large `n`, or an
effects budget of 400, raises `cap` and makes the search worse still. This
runs synchronously in `new PolyflowPlugin(...)`, so a real tool catalogue
(20–40 tools) never finishes starting.

Also, tech spec §4.2 says depth `2·|kinds|+1`; the code uses `|kinds|+2`.

**Fix.**
- Search per guarded kind, and stop as soon as that kind is reached.
- Exclude forbidden kinds from the "all reached" test.
- Abstract counters to `min(v, threshold)` **per rule**, not a global cap.
- Better: reachability over the rule dependency graph (requires-prior and
  implies-prior edges, never-after as blockers, and budgets or at-most `n === 0`
  as sinks) is linear and complete for these rule types.

### AP1: Approvals are unauthenticated

`workflow-interceptors.mjs:276-296`:

- The `polyflow.approve` validator checks only that the escalation is pending
  and that the decision is `approve` or `reject`.
- `principal` is whatever the caller writes.
- The escalation `role` is recorded and never checked.

Anyone with Update permission on the namespace approves. That includes an
agent whose tool activities hold a Temporal client, which is the lethal-trifecta
case this feature exists for.

The code honestly records `verified: false`. Neither the plan nor the specs
defer §5.7 or §6.3's "verified principal", and the P2 review should not pass
FR-HUM.3's "spoofed approver" control (§13) as covered.

**Fix.** Either wire §5.7 (signed `polyflow-principal` header checked against
keys pinned in the policy, plus a role check in the validator), or record an
explicit deferral in the plan and make the pending item say
"approver unverified".

### P1: A quarantined run drops what arrives

`governed-workflow.mjs:97`: when `poisoned`, `step` returns a reject without
`record` and without `remember`. It does not bump `seq` either. Order
completions call `step` and are gone. Timers delete themselves from `timers`
before stepping (`:179`), so a timer that fires during quarantine is gone too.

Test **P1**: a work order completes while the run is poisoned. The journal
holds only `START` and `BOOM` and never shows `WORK_DONE`. After release the
machine still waits in `working` for work that finished.

This violates FR-GOV.3 ("a recorded reject") and makes release unsound: the
operator cannot know what was lost.

**Fix.**
- While poisoned, *queue* proposals (bounded) and journal each one as
  `deferred: poisoned`.
- On release, replay the queue through `step` in arrival order.
- Keep fired timers in the queue rather than deleting them.

### P2: `release` is unvalidated, unrecorded and one-way

`governed-workflow.mjs:214-225`:

- **Any object is accepted as state.** Test **P2** releases with
  `{ anything: 'at all' }` and the Update is accepted. A snapshot missing the
  contract's keys either poisons again at the next step or, worse, is
  silently projected.
- **It is not journaled.** There is no window, no principal and no ledger
  event.
- **It can declare the run finished.** A release to a terminal snapshot
  completes the run by fiat (FR-GOV.4, "done is a state the machine reaches").
- **It re-derives nothing.** It re-arms no timers for the released state and
  issues no orders. MA-11's "every waiting state arms a timer" no longer holds
  after a release.
- **STOP is impossible while poisoned.** Tech spec §5.4 says a poisoned run
  blocks on release **or `STOP`**, but `step` rejects everything while
  poisoned, STOP included.
- **No search attribute is set.** `PolyflowState=poisoned` is never upserted,
  so "visible in the Temporal UI" (FR-GOV.11) holds only through the Query
  tab.

**Fix.**
- Validate the snapshot by rehydrating it through the host: exact contract
  keys, and `setState` must not throw.
- Refuse terminal snapshots unless `force` is given with a reason.
- Journal the release with its principal.
- Let STOP step while poisoned when the machine accepts it.
- Upsert the `PolyflowState` search attribute.

### T1: Effects of the terminal step are cancelled before they run

`governed-workflow.mjs:119-124`: `order(e)` runs for each effect, and then, if
the step is terminal, **every** open order's scope is cancelled. That includes
the ones this same step just created. The schedule and the cancel land in one
workflow task, so the activity never starts.

Test **T1**: `FINISH → done` emits `notify`, and `notify` never runs. polyrun
(`kernel.mjs:550-554`) cancels only *timers* on a terminal step. Its outbox
rows from that step commit with it and execute. A "notify on done" or
"release the hold" effect is common, and here it is silently dropped.

**Fix.** On a terminal step, cancel orders created by **earlier** steps only,
and only when the manifest marks them cancellable. Then let the loop's
`Promise.allSettled(inflight)` wait for the new ones. The comment at `:242`
already describes that intent.

### H2: Permanent failures without `onFailure` vanish

`machine-host.mjs:255-258` sends `permanent` only to `onFailure`. polyrun
(`workers.mjs:128-146`) treats a `{permanent}` throw with no `onFailure` as a
normal failure: it retries until exhausted, then dispatches `onExhausted`.

Test **H2**: with only `onExhausted` declared, the host returns `null`, and
`governed-workflow.mjs:160` steps nothing. At G1+G2 every guard denial is a
permanent failure (`isPermanent` treats `PolyflowDenied` as one), so a denied
work order on such an effect leaves the run waiting for its timer, or forever.

**Fix.** Use `hook = outcome === 'success' ? onSuccess : outcome === 'permanent'
? (onFailure || onExhausted) : (onExhausted || onFailure)`. When nothing is
wired, journal an `unwired-completion` window so the loss is visible.

### CN1: Continue-as-New is unreachable in practice, and untested

`governed-workflow.mjs:231,238` continue as new only when
`continueAsNewSuggested && inflight.size === 0 && timers.size === 0`.

- FR-GOV.8 and MA-11 require every waiting state to arm a timer. customer-brief's
  `approvalWindow` stays armed from `review` until the terminal step (the mapper
  never cancels it). A live governed run therefore never has zero timers, and
  never continues as new.
- A chatty machine (many accepted Updates while one timer is armed) hits the
  server's per-run update and history limits instead.
- The "updates received pass 1,500" trigger from §5.4 is not implemented.
- Tech spec §5.4 says open orders are *not* carried: their completions arrive
  via the gateway. The code waits for them instead.
- The dedupe table (`results`), the journal and `orderSeq` are not carried, so
  a duplicate delivered after CaN is stepped again (FR-GOV.3 acceptance).
- P3.4 ("forced CaN mid-run; final state and effect count unchanged") has no
  test in `governed.test.mjs`.

**Fix.**
- Carry timers as `{ key, fireAt, action, data }` and re-arm them on start.
- Carry a bounded dedupe set.
- Either carry open orders, re-issuing them by orderId with an idempotent
  activity id, or implement the gateway path the spec describes.
- Add the update-count trigger and the P3.4 test. The dev server's
  `limit.historyCount.suggestContinueAsNew` dynamic config can force the
  suggestion.

### C1: `startGoverned` lets the caller override the derived id

`client.mjs:83-91`: `...options` is spread **after** `workflowId`, `args`,
`workflowIdConflictPolicy` and `workflowIdReusePolicy`.

Test **C1** passes `workflowId: 'whatever-the-agent-likes'`. The run starts
under that id, while `startGoverned` returns `workflowId:
'polyflow/customer-brief/2026-04-01'`. Passing
`workflowIdReusePolicy: 'ALLOW_DUPLICATE'` re-runs completed work, and `args`
can inject a `snapshot` (see S2). Gateways forward caller options, so this
defeats exactly what the function is for.

**Fix.** Spread `options` first, then the fixed fields. Or allow-list the
options a caller may set (timeouts, memo, search attributes, and so on) and
refuse `workflowId`, `args`, `workflowIdConflictPolicy` and
`workflowIdReusePolicy`.

---

## Minor

- **G8: cancelled escalations stay pending.**
  - `workflow-interceptors.mjs:175-178`: when `condition` rejects with a
    cancellation, `pending.delete` never runs.
  - Test **G8**: the workflow gives up after 1 s, but `polyflow.pending` still
    lists the escalation, and `polyflow.approve` is accepted and recorded as a
    human proposal for an effect that will never run. The inbox shows ghosts,
    and the ledger shows approvals for nothing.
  - The ledger also never gets a verdict closing the `escalated` one.
  - The same happens when a governed terminal step cancels an order that is
    parked in escalation.
  - **Fix:** use `try/finally` around the wait. On cancellation, delete the
    pending entry and append `verdict(cancelled)`.
- **G4: a negative meter reading refunds the budget.**
  - `rules.mjs:24-28,193-194` accept any finite number, so a buggy or hostile
    tool result of `-100000` refunds the budget (test **G4**, meter at
    −96 400).
  - **Fix:** ignore negative values, record them as a finding, and clamp the
    meter at ≥ 0.
- **G6: declassification is credited by completion order.**
  - `observe` sets `declassified` when the declassify kind *completes*
    (`rules.mjs:196`). A redaction scheduled before the reads, and finishing
    after them, clears taint for data it never saw (test **G6**, which is
    plain `Promise.all([redact(), fetch(), read()])`).
  - **Fix:** record the commit seq of the declassify effect, and clear taint
    only if no taint-setting observation *committed* after it.
- **G9: failed reads do not taint.**
  - `observe` returns early on `!ok` (`rules.mjs:188`), before labels are
    applied. The failure message of a `reads-untrusted` fetch still reaches
    the agent (the ledger text is redacted; the text the agent receives is
    not).
  - **Fix:** apply `reads-untrusted` taint on failures too. Treat
    `reads-private` conservatively as well.
- **K1: key derivation collisions.**
  - `key.mjs:263`: `replaceAll(`{f}`, value)` interprets `$$`, `$&`, `` $` ``
    and `$'`, so `a$$b` and `a$b` derive the same key (test **K1**).
  - It also substitutes into an already-substituted string, so
    `{a:'{b}', b:'x'}` and `{a:'x', b:'x'}` collide.
  - `workflowIdFor` joins with `/` and accepts `/` in machine names and in
    given keys: machine `a/b` key `c` equals machine `a` key `b/c`. With
    `USE_EXISTING`, one machine's caller then **attaches to another machine's
    run**.
  - Patterns are unanchored unless the author anchors them.
  - **Fix:**
    - Substitute in one pass: `template.replace(/\{(\w+)\}/g, (_, n) => values[n])`.
    - Refuse `/` in machine names.
    - Percent-encode or refuse `/` in keys.
    - Anchor patterns (wrap as `^(?:…)$`).
- **H3: scalar results become `{ value }`.**
  - `machine-host.mjs:261` builds `{ value: result }` where polyrun passes
    `{}`. A strict schema without `value` then rejects the completion as a
    `SamSchemaError`, so the completion is lost as a reject (test **H3**).
- **V1: the Update validator is not a full dry run.** `dryRun` skips the
  mapper, so an Update is *accepted* and then poisons the run in its handler.
  The `BOOM` fixture shows it. The caller gets `{ stepKind: 'poisoned' }` as a
  successful Update result. Run the mapper in `dryRun`: it is pure.
- **D1: actionId reuse across actions is silent.** `governed-workflow.mjs:96`
  answers a reused `actionId` with the cached result whatever the action is.
  polyrun raises `ConflictError`. Answer only when the action matches, and
  reject otherwise.
- **Q1: queries leak raw data.**
  - `polyflow.journal` returns every window's `data`, `pre` and `post`
    verbatim, including notes, amounts and any PII in proposals.
  - `polyflow.state` returns order payloads.
  - The ledger redacts and stores digests, so the query path undoes that for
    anyone with query permission.
  - Project the journal to the ledger's shape (digests) by default.
- **M1: unbounded growth.**
  - `orders` is never pruned.
  - `journal` keeps 500 full pre/post snapshots in workflow memory. That is
    cheap for customer-brief, but for a machine with a large state it exceeds
    the Query payload limit, and the query then fails.
  - Prune closed orders, and cap the journal by bytes.
- **C2: `startGoverned` races and reporting.**
  - Describe-then-start: two concurrent callers both see "not found", both
    call start, and the second is silently attached (USE_EXISTING) but reports
    `status: 'started'`.
  - A FAILED, TERMINATED or TIMED_OUT run is reported as `complete` with "do NOT
    start another run", so an agent is told a failed job is done.
  - §5.4 and FR-GOV.5 say signal-with-start or update-with-start. The code uses
    describe plus start.
  - Use the start response's `started` flag (or `executeUpdateWithStart`), and
    report the closed run's actual status.
- **C3: order ids are not run-unique.** `runKey = workflowId`
  (`governed-workflow.mjs:76`). A reset, or a run started with
  `ALLOW_DUPLICATE`, reproduces the same orderIds. Since external completion is
  addressed by `(workflowId, orderId)` (§5.4), a late completion from the
  previous run completes the new run's order. Include the first execution's
  runId.
- **SP: spec and code mismatches.**
  - The §3.4 example policy is refused by `admitPolicy`: `"outcome": "ok"` is
    not deny or escalate, and the `token-budget` rule has no `from`.
  - `trifecta` ignores its declared `egress`, `untrusted` and `private` fields
    and hard-codes the labels.
  - Rule type `machine` (§3.4, §4.4) is not in `RULE_TYPES`, so a policy that
    uses it is refused.
  - `escalation.budgetPerHour` (FR-HUM.5) is silently dropped.
  - Admission depth is `k+2`, not `2k+1` (§4.2).
  - `never-after { signal }` sees only Temporal signal *names*. In a governed
    run a `CANCEL` arrives as `polyflow.propose` (Signal) or through the Update,
    which the guard never sees, so §3.4's `no-post-after-cancel` example can
    never fire under G2.
  - `requires-prior` with the default `bind: 'any'` counts the approval
    *activity's* success. A human who answers "no" through an activity that
    returns normally still licenses the post (FR-GRD.2's acceptance says "no
    prior APPROVED").
  - No search attributes (`PolyflowLevel`, `PolyflowMachine`, `PolyflowState`, …)
    are set anywhere, although §5.4 specifies them.
  - `polyflow.state` has no `level`, `certificate` or `head`.
- **TG: test gaps against the plan.**
  - P2.4 names three CapLease scenarios. On Temporal only approve, reject and
    timeout run. Crash-after-approval and replan-with-changed-amount exist only
    as a kernel test.
  - P2.5: there is no FR-GRD.7 fixture.
  - P3.4 (CaN) and P3.5 (poison, quarantine, release) have no tests.
  - Governed timers are never exercised on Temporal.
  - FR-GRD.8's "1,000 replays" is one replay each for guard and governed.
  - There is no replay test for a history with an escalation that was *approved*.
    The existing guard replay test replays `replanningAgent`, which never
    escalates, so its title overclaims.

## Nits

- `commit` runs before `next()`. When the scheduling throws synchronously and
  the workflow catches it (an unregistered local activity raises
  `ReferenceError` inside the next handler), the approval is consumed, the
  counters move, and the ledger shows an effect plus a failed observation for
  something that never reached history.
- A metered budget allows the call that crosses it (`used < max`). That is
  fine, but say so in the witness text.
- `escalation.timeoutMs: 0` is admitted. Every escalate-guarded kind is then
  unreachable, yet admission counts escalations as approvable.
- A budget cannot be marked `forbid: true`, because `forbidden` is keyed by
  `guards`. A budget of 0 on a kind is always refused.
- Timer actionIds are `timer:<key>:<fireAt>`. A key re-armed at the same
  absolute `fireAt` after it has fired is deduped away. polyrun uses
  `sha(instance, key, seq)`.
- The comment at `governed-workflow.mjs:242` ("let completions … land as
  observable rejects") describes orders that were in fact just cancelled.

---

## What held up

- **Synchronous decide and commit.** In `governed()`, decide → append → commit
  run with no `await` between them, both on the allow path and after an
  approval. So `Promise.all` of guarded activities in one workflow task sees a
  consistent state: consuming credits and approvals cannot be double-spent by
  siblings. The G3 bug is a *deny-after-grant* leak, not a race.
- **Two approvals in one task.** The validator rejects the second (`already
  decided`) because the first handler runs synchronously before the next
  validator. A late approval after the timeout is refused (`no pending
  escalation`), because the entry is deleted when the wait returns.
- **Determinism.**
  - approvalIds derive from the ledger seq.
  - `Date.now()` is workflow time.
  - Maps iterate in insertion order, and every insertion is history-driven.
  - Update and Signal handlers step synchronously, so no two proposals
    interleave, and there is no validator/handler TOCTOU inside one
    activation.
  - Timers use their own cancellation scopes and check identity before
    stepping, so a cancelled-then-fired timer is inert.
  - The existing replay tests pass, and nothing found here depends on
    non-history input.
- **Per-effect binding.** A retry of a *server-scheduled* activity never
  re-enters the guard, so it needs no second approval. A different args digest
  needs a new approval. Crash-after-approval replays to the same consumed
  state, because guard state is recomputed from history.
- **A denial is a result.** Nothing is scheduled, the non-retryable
  `PolyflowDenied` carries a witness with `allowedNow` and a `fix` sentence
  generated from the rule type, and the denial rides the next carrier or the
  close flush.
- **Machine host parity with polyrun** holds for everything tested: rehydrate
  per call, strict classification, mutate-then-reject poisons, undeclared kind
  poisons, duplicate timer key poisons, intent ids byte-identical, and
  `unhandled` versus `rejected`.
- **Stale and duplicate deliveries** within one run are observable rejects or
  deduped answers, as FR-GOV.3 asks, outside the quarantine and CaN cases
  above.
- **Policy parsing** lists every problem, not the first. It refuses unknown
  types, undeclared kinds and self-priors, and demands `forbid` for `n: 0`.
- **Admission refuses the mutual-prior deadlock** and similar cycles
  correctly. The problem with the search is its cost (A1), not its verdicts:
  no satisfiable policy was found refused, and no unreachable guarded kind was
  found admitted.

---

## Response (author, after the review)

Both blockers and every major finding are fixed, or narrowed in the spec
where the claim was wrong. The reviewer's tests stay in the suites as
regression tests. Three of them were adjusted, and the reason for each is
below. A new `continue-as-new.test.mjs` covers the untested P3.4 row. After the
fixes: kernel 60, temporal 57 (run one file per process by
`scripts/test-each.mjs`), cli 15, gateway 4. All are green.

| # | Outcome | What changed |
|---|---|---|
| S2 | fixed | `GovernedWorkflow` accepts a `snapshot` only when `continuedFromExecutionRunId` is set. It also runs `host.checkSnapshot` on it: exact contract keys, and the state must survive a rehydration unchanged. Any other snapshot is refused with `PolyflowSnapshotRefused`. |
| S1 | fixed | A **completion action** (any `onSuccess`, `onFailure` or `onExhausted` target in the manifest) is accepted from outside the machine only with the `orderId` of an **open** order of a kind it completes. The report closes that order, calls off its activity, and uses the same actionId the worker-side completion would (`<orderId>:done`), so the two can never both land. A bare completion is refused with "report it against the order", both in the Update validator and on the Signal path. Test adjustment: the reviewer's S1 test released the parked approval in `finally`, and **that release is the human's approval**, so `posts === 1` afterwards is correct. The assertion now runs before the release. |
| G1 | fixed | `signalWorkflow` and `startNexusOperation` go through `governed()`, classified as `signal:<name>` and `nexus:<service>/<operation>`. They fall back to `unlabelled`. |
| G2 | fixed | An unlabelled escalation can be approved. |
| G3 | fixed | Approvals carry the `proposal` id they were granted for, and `approvalFor` matches it. When a re-decision after a grant is a denial, `voidApproval` kills the approval. Test adjustment: the reviewer's G3 test granted approvals without a proposal id. The interceptor always supplies one, so the test now models that. |
| G5 | fixed | An undeclared effect is checked against every budget that has no `kinds` list. |
| G7 | fixed | A local activity retried after backoff (attempt > 1) is matched to its first attempt by activity type and argument digest, because the first attempt has no `originalScheduleTime`. It gets an observation-only record under the first effect's id. A `LocalActivityDoBackoff` is not recorded as an outcome. |
| B1 | narrowed | FR-GRD.7 now says what the guard can see: every effect the **workflow** orders. Retries the Temporal server performs for one scheduled activity count as one effect, and that activity's retry policy bounds them. A negative reading closes the budget. |
| A1 | fixed | Reachability runs once per kind, over the closure of that kind's prior kinds only. Every other rule type can only block, so leaving those kinds out is sound. 11 kinds with one forbidden kind: under 1 ms, previously 16 s. |
| AP1 | deferred, with a plan row | Plan step **P5.5 (verified principals)** is new. Until it lands, every approval and report is recorded `verified: false`, and this review does not count the "spoofed approver" control as covered. |
| P1 | fixed | A proposal arriving while the run is quarantined is **held**: it is journaled as `held` and replayed in arrival order on release. `STOP` (the descriptor's `stopAction`) steps even while poisoned. |
| P2 | fixed | `release` validates the snapshot through `checkSnapshot`. It refuses a terminal snapshot unless `force` is given, journals the release with its (unverified) principal and reason, and replays what was held. **Deferred:** re-deriving timers for the released state (P9), and the `PolyflowState` search attribute. Search attributes need namespace registration, so they belong with the service in P8. |
| T1 | fixed | A terminal step cancels only orders that were open **before** it. Effects that step orders run, as in polyrun. |
| H2 | fixed | A permanent failure with no `onFailure` falls through to `onExhausted`. When nothing is wired at all, the report path journals an `unwired` window. |
| CN1 | fixed | Continue-as-New no longer waits for zero timers or zero orders. It carries armed timers (the same `fireAt`) and open orders (the same order id, re-issued at-least-once, as polyrun re-offers a lapsed lease). It waits for `allHandlersFinished()` first. It also runs on `continueAsNewSuggested` or a pending migration. `continue-as-new.test.mjs` is the P3.4 test: a run continues as new mid-flight, keeps its state, re-arms its timer at the same time and re-issues its order under the same id, and posts once. **Deferred:** carrying the dedupe table. Duplicates across a hand-over are absorbed by the machine's own stale-completion rejects. |
| C1 | fixed | `startGoverned` refuses `workflowId`, reuse policies, `args` and `taskQueue` in its options with a `KeyError`. Test adjustment: the reviewer's C1 test expected the override to be ignored silently. Refusing it is the stronger fix, so the test now asserts the refusal. |
| G8 | fixed | The pending escalation is removed in a `finally`, whether it was answered, timed out or abandoned. |
| G4 | fixed | A negative meter reading closes the budget (fail closed). |
| G6 | fixed | A declassification counts only if it was **ordered** after the last tainting read. |
| G9 | fixed | A failed untrusted read taints. |
| K1 | fixed | `deriveKey` substitutes in one pass over the template with a replacer function, so `$` patterns are not interpreted and values are not re-scanned. `workflowIdFor` URI-encodes the machine and the key. |
| H3 | fixed | A scalar result maps to `{}`, as in polyrun. |
| V1 | fixed | The Update validator runs the full step, mapper included, and refuses a proposal that would poison the run. |
| D1 | fixed | An actionId reused for a different action is refused, not answered from the cache. |
| Q1 | deferred to P8 | Queries are namespace-internal. Redacted views belong with the service's inbox. |
| M1 | fixed | Closed orders are pruned beyond 200. The journal query was already bounded at 500. |
| C2 | fixed | A failed, terminated or cancelled run is reported as `ended` with its status, and is no longer called complete. The describe-then-start race still reports `started`. That is harmless, and the code says so. |
| C3 | fixed | Intent ids derive from `workflowId:firstExecutionRunId`. |

One more defect turned up while building P5, found by the gateway tests. Temporal
delivers buffered Updates **the moment their handler is registered**. A report
that arrived with the run's first workflow task therefore found no orders,
because the start step ran after `setHandler`. The start step and the carried
orders and timers now run before any handler is registered.
