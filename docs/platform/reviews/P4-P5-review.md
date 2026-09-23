# Review: P4 (G3 Certify) and P5 (Agents and crews)

This is an adversarial review of admission, certificates, the version gate,
external-mode work orders, reports, claims and the MCP gateway:

- `platform/packages/kernel/src/{certificate,explore}.mjs`
- `platform/packages/cli/src/{admit,main}.mjs`
- `platform/packages/temporal/src/{certificates,vet,gate-workflow,gate-activities,governed-workflow,plugin}.mjs`
- `platform/packages/gateway/src/*.mjs`, with the root `src/tools.mjs` (`makeTools`) it reuses
- `platform/examples/{customer-brief,customer-brief-v2}` and polyvers (`polygraph/polyvers`)

The review checks the code against the functional spec (FR-ADM, FR-VER,
FR-HUM.1–2, FR-AGT.3), the technical spec (§3.5, §4.1, §5.4–5.6, §6.1–6.2, §7,
§8) and the P4 and P5 rows of the implementation plan. It also re-checks the
P2/P3 fixes that P4 and P5 touch (S1, S2, P2, CN1). The reviewer did not
write the code and changed no production code.

## How to reproduce

Each failing test asserts what the spec, or an earlier review's fix, claims.
Each one **fails today**, for the reason its message gives.

| File | Tests | Needs server |
|---|---|---|
| `platform/packages/cli/test/review-p4p5-admit.test.mjs` | AB1, IN1, DEP1, PL1, BV1, SA1 | no (about 1 s) |
| `platform/packages/temporal/test/review-p4p5-vet.test.mjs` | VG2 | no (polyvers subprocess, about 3 s) |
| `platform/packages/temporal/test/review-p4p5-temporal.test.mjs` | FO1, FO2, RP1, RL1, PC1, MG1, MG2, CL1, GC1 | yes (about 30 s) |
| `platform/packages/temporal/test/fixtures/review-p4p5-workflows.mjs` | the GC1 fixture: post, Continue-as-New, post again | – |
| `platform/packages/gateway/test/review-p4p5-gateway.test.mjs` | GW1 | yes (about 12 s) |

```
cd platform/packages/cli      && node --no-warnings --test test/review-p4p5-*.test.mjs
cd platform/packages/temporal && node scripts/test-each.mjs review-p4p5
cd platform/packages/gateway  && node --no-warnings --test --test-concurrency=1 test/review-p4p5-*.test.mjs
```

The baseline at review time was all green:

- kernel: 68/68
- cli: 15/15
- temporal `vet`, `gate` and `continue`: 7/7
- gateway: 4/4

All 17 review tests fail. Every parked activity is released in a `finally`.
Every run a test leaves open is terminated. Temporary machine directories go
under `examples/.tmp-*` and are removed.

---

## Summary

| # | Severity | Finding | Evidence |
|---|---|---|---|
| FO | **blocker** | `GovernedWorkflow` takes `orders`, `timers`, `seq` and `mode` (Continue-as-New carry fields) from **any** start. The S2 fix guards only `snapshot`. A forged start orders `post_brief` with a payload the caller picks, and the machine never emitted it. A forged timer delivers an order's completion. | FO1, FO2 |
| RP | **blocker** | Review S1 is back, through `polyflow.report`. An order addressed to a person (`performer: human`) is answered by anyone who can send an Update. The human's activity is cancelled and the brief is posted. The gateway's own happy-path test does exactly this. | RP1, `gateway.test.mjs:51` |
| MG | **blocker** | `polyflow.migrate` replaces the run's state with anything that is an object. No principal is needed, nothing is validated, and nothing links it to a gate decision. One Update fails the run for good, or puts it in any state with the right keys (review S2, reopened). It also takes a poisoned run out of quarantine without `release`'s checks. | MG1, code |
| VG1 | **blocker** | There is no Worker Versioning integration anywhere. *auto-upgrade* and *pin* are only journal rows. A migration hands over to whichever worker polls the queue. During a ramp (the only time the gate runs) that can be the old worker, which refuses the migrated snapshot and fails the run (MG1 shows this failure mode). FR-VER.2, FR-VER.6 and FR-ADM.6 are claimed and not built. | code, MG1 |
| PC | major | "Only the holder may report" holds for `report` but not for `propose`: `outOfBand` checks that the order is open, not who holds it. | PC1 |
| RL | major | The claim validator checks the role only when the caller sends `actor.roles`, so an actor with no roles claims any order. `report` checks no role at all. Actor identity is a payload field on every Update (P5.5 is not built). | RL1 |
| MG2 | major | `migrate` carries no *from* state. When the run moves between the fleet read and the apply, the gate's stale snapshot rewinds it. `apply` is not idempotent and has no partial-failure handling. | MG2 |
| CL | major | Claims, the dedupe table, held proposals and the journal are not carried across Continue-as-New. After a hand-over, anyone reports an order someone else holds. | CL1 |
| GC | major | Guard state does not survive Continue-as-New, although tech spec §4.1 says it round-trips. `at-most-one-post` allows a second post. `GovernedWorkflow` now continues as new on `continueAsNewSuggested` and on any `migrate` Update, so any Update caller can reset budgets. | GC1 |
| EX | major | External mode schedules no activity, so the G1 guard, the ledger's effect records and every policy rule are bypassed for every order. The mode is picked per run by whoever starts it. It is not per performer as in §5.5, and the certificate says nothing about it. | code |
| VG2 | major | `vet` passes versions that admission refuses. For the composition lane, polyvers PASSes with `check-effects` deferred. `vet` ignores `report.deferred` and never checks the new version's certificate. `vet` also sees only machine state, not open orders, so a renamed effect kind auto-upgrades a run whose in-flight order then has no completion. | VG2, probe |
| VG3 | major | The fleet is not scoped to the version being replaced. The `PolyflowCertificate` search attribute is never upserted, and the query covers every running `GovernedWorkflow`. Runs under non-derived ids are skipped. The spec's Replayer step does not exist. No `admission` event reaches any ledger. | code |
| AB | major | `--accept-bound` crashes instead of certifying. `admit` marks the bounded check `ok:false`, and `buildCertificate` throws on any `ok:false`. A bounded structural walk also reports spurious "stuck" states. | AB1 |
| IN | major | State invariants (`invariants.mjs`) are digested into the certificate and never evaluated: not at admission, not at `checkSnapshot`, not at `migrate`. | IN1 |
| DEP | major | The certificate covers nine named files, not the code that runs. A local module the machine `require`s, and the `sam-pattern` version, can change after admission and the worker still starts. | DEP1 |
| PL | major | The certified `policy.json` is not the policy the worker enforces. The plugin's `policy` option (or `level: 'observe'`, meaning no policy) is independent of the machine's certificate. | PL1 |
| BV | major | `plugin.buildId()` exists and nothing calls it. Worker deployment options are neither set nor checked (§7.2 "any mismatch fails `Worker.create`"). | BV1 |
| SA | major | `loadMachineDir` drops `stopAction` and `claimLeaseMs` from the descriptor. So STOP never ends a quarantine on Temporal, the lease setting is ignored, and admission reports a missing STOP as "not checked" and passes it (plan P5.4 says it refuses). | SA1 |
| WT | major | `waits-on-people-arm-timers` covers only `performer: 'human'`. The spec says every waiting state. In external mode every order is a wait, and customer-brief's gathering, drafting and posting waits have no deadline. The check never asks whether the timer's action actually leaves the wait. | code |
| GW1 | minor | A retryable `workflow_report` always waits out the full 10 s settle timeout. | GW1 |
| — | minor | See the minor list: reports that close an order whose completion is rejected or unwired; no domain or type check on report data; a silent uncertified mode; a non-reproducible `buildId`; polyvers loading different files from the ones certified; orders dropped during `handOver`; `apply` payload size and retries; gateway restart loses the order map; FR-AGT.3 and §6.1 gaps; admit TOCTOU and optional checks; spoofable `polyflow.version`. | code |
| TG | minor | Plan rows claimed without a test (see below). | tests |

---

## Blockers

### FO: the start arguments hand the run work and completions the machine never produced

`governed-workflow.mjs:79,97-106,268-269`: the S2 fix refuses `snapshot`
unless `continuedFromExecutionRunId` is set. The other carry fields,
`orders`, `timers`, `seq` and `mode`, are accepted from any `start`:

```js
for (const t of carriedTimers) armTimer(t);
for (const e of carriedOrders) order(e);
```

- **FO1** starts `GovernedWorkflow` with
  `orders: [{ intentId: 'forged-1', kind: 'post_brief', payload: { ticketCount: 99 } }]`.
  `post_brief` is scheduled in the first workflow task and runs once, while
  the machine is still in `gathering`. No step emitted it, and no approval
  exists. The guard (G1) sees the activity, but G2's claim ("the machine
  decides what happens next") is gone.
- **FO2** starts with a carried timer
  `{ action: 'TICKETS_READY', data: { count: 7 } }`. Timer steps go straight
  to `step()` and skip `outOfBand`, so the completion of the fetch order is
  delivered by the caller. The run moves to `drafting` with `ticketCount: 7`
  while the real fetch is still parked.

**Fix.**
- Accept `orders`, `timers`, `seq` and `snapshot` only together, and only
  when `continuedFromExecutionRunId` is set.
- Better: carry them in a header the plugin writes at `continueAsNew`, the
  way the ledger head is carried (review M4), not in workflow arguments.
- Accept `mode` only if the descriptor allows it (see EX).
- Carried timers should re-arm only keys the machine armed. Their firing is
  still a `timer` source, so keep the action and data from the carried
  record, which the handing-over execution wrote.

### RP: an agent answers the human's order through `polyflow.report`

`governed-workflow.mjs:388-418`: the report validator checks two things:

- the order is open;
- if the order is claimed, the reporter is the holder.

It never checks the order's `role`. An unclaimed order has no holder, so
anyone reports it.

**RP1** is worker mode:

1. `request_approval` (performer `human`, role `human`) is parked in its
   activity.
2. A client sends `polyflow.report { orderId, ok: true }` with no actor.
3. The Update is accepted. The approval activity is cancelled (`closeWith` →
   `o.scope.cancel()`), `APPROVED` is stepped, and `post_brief` runs.

The gateway's `gateway.test.mjs:51` does the same as its *happy path*: one
agent with no actor reports `ask_user`, the human approval, and the brief is
posted.

This is P2/P3's blocker S1 again. That fix moved "completion actions need an
open orderId" into `propose`. The new report path, which is the one agents
actually use, has no equivalent. §5.5 says human-role orders are routed to
the inbox. Nothing routes them.

**Fix.**
- A report (and a `propose` with `orderId`) on an order whose `role` is set
  must come from a principal holding that role. Until P5.5 lands, refuse
  reports on `performer: human` orders from any Update that does not carry a
  verified human principal.
- In worker mode, refuse reports on orders whose kind has a worker handler,
  unless the descriptor opts in.

### MG: `polyflow.migrate` is an unauthenticated state overwrite

`governed-workflow.mjs:420-433`: the validator checks three things:

- the run is not terminal;
- the snapshot is an object;
- no migration is pending.

The handler sets `pendingMigration`, and the run continues as new with that
state. The next execution checks the snapshot with `host.checkSnapshot`,
which checks keys and `setState` round-trip only.

- **MG1:** a snapshot with one extra key is accepted. The next execution
  throws the non-retryable `PolyflowSnapshotRefused`, and the run ends
  **FAILED**. One Update from anyone ended a governed run.
- `checkSnapshot` accepts `{ briefState: 'nonsense' }` and
  `ticketCount: -5` (checked directly with the kernel host). So `migrate`
  puts a run in any state with the right keys: an unreachable one, or one
  that violates the machine's own state invariants. This is S2 again: a
  state handed in skips every guarantee the certificate states.
- The main loop hands over when `pendingMigration !== null`, even while the
  run is poisoned (`:461`). So `migrate` takes a run out of quarantine
  without `release`'s validator (P2's fix), and the held proposals are
  dropped because `held` is not carried.
- The migration is recorded only in the in-memory journal, which is not
  carried either. FR-VER.2 asks for an `admission` event in the run's ledger.

**Fix.**
- Accept `migrate` only from the gate. Carry a gate-signed decision (gate
  workflow id, from build id, to build id, from-state digest) and check it,
  or at minimum a verified operator principal.
- In the validator, require `from` to equal the current state (see MG2).
- Validate the snapshot against the **new** contract and its state
  invariants. The gate has them; the workflow has only the old machine, so
  the gate must attest to that validation.
- Refuse `migrate` while poisoned, or route it through `release`.
- Append a ledger `admission` event through the interceptor.

### VG1: the version gate is not wired to Worker Versioning

`grep -r "workerDeploymentOptions|versioningBehavior|VersioningOverride|upsertSearchAttributes|PolyflowCertificate"`
over `packages/` returns nothing.

- `gate.apply` (`gate-activities.mjs:72-85`) sends `polyflow.version` for
  *auto-upgrade* and *pin*. The handler (`governed-workflow.mjs:434-437`)
  only appends a journal row. No versioning override is set. A *pinned* run
  is pinned to nothing.
- `migrate` continues as new onto the same task queue. With no deployment
  versions, the next task goes to any worker polling it. During a ramp that
  can be the old worker, which refuses a new-shape snapshot and fails the run
  (MG1 shows the same failure on one worker). The gate test avoids this by
  shutting the v1 worker down before starting v2
  (`gate.test.mjs:107-125`).
- The plugin never sets or checks a deployment build id (BV), so "the
  certificate is the version" (FR-ADM.6) is a method nobody calls.
  `toBuildId` is a free string, `'v2'` in the test, with no link to any
  certificate.
- There is no Replayer step (§5.6.3) and no integration with the
  temporal-worker-controller (FR-VER.6). Both are claimed by the module
  header and by the spec.

**Fix.**
- Set `workerDeploymentOptions` from the certificate `buildId` in
  `configureWorker`, and refuse a mismatch.
- Give `GovernedWorkflow` a declared versioning behaviour.
- In `apply`, call `UpdateWorkflowExecutionOptions` with a versioning
  override: PINNED to the old version, or AUTO_UPGRADE. A migrated run is
  handed over with a pinned override to the **new** version, so the old
  worker can never pick it up.
- Upsert `PolyflowCertificate`, and query by it.
- Until then, say in the docs that *pin* and *auto-upgrade* are recorded,
  not applied.

---

## Major

### PC: `propose` ignores claims

`outOfBand` (`governed-workflow.mjs:290-298`) admits a completion action when
the named order is open and of the right kind. **PC1:** alice claims the
fetch order, then an Update `propose { action: 'TICKETS_READY', orderId }`
with no actor is accepted. FR-HUM.2's "only the holder may report" is
enforced on one of the two paths. The P2/P3 review said "when P5 lands, the
order's role check replaces the orderId check". It was not replaced.

**Fix:** give `propose` with an `orderId` the same holder and role checks as
`report`, through one shared function.

### RL: role checks are opt-in, and identity is a payload field

- `claim` validator (`:382`):
  `if (o.role && Array.isArray(actor.roles) && !actor.roles.includes(o.role) && o.role !== 'agent')`.
  An actor with no `roles` array skips the check. **RL1:** `{ id: 'mallory' }`
  claims the human approval.
- The `o.role !== 'agent'` special case is not in the spec.
- `report` checks no role at all (RP).
- The gateway rightly takes the actor from its own configuration, never from
  tool arguments (`temporal-polyflow.mjs:57,158,190`). But at the Temporal
  boundary, `actor` is a field of the Update payload: any client names any
  actor. P5.5 (verified principals) is not built, and the code records
  `verified: false`, which is honest. Still, P5.3's acceptance ("only the
  holder can report") is claimed on the strength of self-declared ids.

**Fix:**
- Treat a missing `roles` as holding none.
- Drop the `agent` bypass, or specify it.
- Check the role on report and on propose.
- Keep P5.3 marked "unverified principals" until P5.5 lands.

### MG2: migrations can rewind runs; `apply` is not idempotent

**MG2** reads the state while the run is in `drafting` (as the fleet
activity does), lets the run move to `review`, then applies
`migrate({ snapshot: drafting })`. The next execution is back in `drafting`.
The `review` step, and the approval order it created, are lost. The carried
orders come from the *current* run, so the rewound state has orders for a
different state. In worker mode the same race can re-issue an order that
already ran, `post_brief` included.

`apply` (`gate-activities.mjs:72-85`) has further problems:

- A run that closed between the fleet read and the apply makes `executeUpdate`
  or `signal` throw. The activity fails after migrating some runs and not
  others, and the gate fails with no record of which.
- The activity retries (`maximumAttempts: 3`) re-run the loop from the top.
  Runs already migrated get `migrate` again with the same stale snapshot. The
  validator's "already pending" guard does not survive the hand-over.

**Fix:**
- Send `from` (or its digest) with every decision, and refuse in the
  validator when the state has moved. The run then goes back to the next
  gate run.
- Make `apply` idempotent: use an Update id derived from (gate run, workflow
  id), treat "workflow closed" as `skipped`, heartbeat progress, and return
  per-run outcomes.

### CL: what Continue-as-New drops

`handOver` (`:444-454`) carries `{ intentId, kind, payload, attempt }` per
open order, the timers, `seq`, the state and `mode`. It drops:

- `claimedBy` and `claimedUntil`. **CL1:** alice's claim is gone after an
  identity migration, and bob reports her order.
- `results`, the actionId dedupe table. A client that retries an Update
  across a hand-over gets a second step, not the cached answer. This is P2/P3
  CN1's "dedupe table is not carried", which is still open.
- `held`: proposals held while poisoned (see MG).
- The journal, which the gateway's `workflow_journal` presents as "a valid
  Polygraph trace corpus". It restarts empty at every hand-over.

Also, `open` is computed *before* the `await`s in `handOver`, while
`carryTimers` is computed after the first one. So an order created by a step
that lands during the hand-over (a timer firing, an Update) is not carried,
while the timers it armed are. The window is narrow in external mode and a
workflow task or two in worker mode.

**Fix:**
- Carry claims, a bounded dedupe table and `held`.
- Carry a journal digest and head, so the corpus can be stitched.
- Compute `open` after the last `await`, and stop accepting proposals once
  the hand-over starts (validators refuse "handing over").

### GC: guard state resets at every Continue-as-New

Tech spec §4.1: "[guard state] is canonical JSON, so it round-trips through
Continue-as-New". It does not. `makeInterceptors` builds a fresh governor
per execution (`guard.init()`), and `continueAsNew` hands over only the
ledger head (`workflow-interceptors.mjs:310-315`).

**GC1** posts under `at-most-one-post`, continues as new, asks approval
again and posts again. Both posts are allowed. Every count, budget, taint
flag and unconsumed approval resets.

This mattered little while nothing continued as new. Now `GovernedWorkflow`
hands over on `continueAsNewSuggested`, and on **any** `polyflow.migrate`,
which needs no authorisation (MG). So any Update caller can reset a run's
budgets whenever they like.

**Fix:** put `governor.state()` in the `HEAD_HEADER` payload at
`continueAsNew`, accept it only when `continuedFromExecutionRunId` is set
(as `resume` is), and restore it before the first decision.

### EX: external mode bypasses the guard and the ledger

`order()` returns before scheduling anything when `mode === 'external'`
(`:212`). The G1 guard and the ledger's effect and observation events live
in the outbound activity interceptor, so in external mode:

- no order is ever proposed to the guard;
- no rule, budget, approval or trifecta applies;
- the ledger records no effect for the work the agent does.

Every gateway run is external (`temporal-polyflow.mjs:99`). The mode is also:

- chosen per run by whoever starts it, not per performer as in §5.5 (worker
  handler / external agent / human);
- carried across Continue-as-New;
- not visible in the certificate.

So a crew with worker-side handlers and one human approval cannot be built.
§5.5's design (the activity records a task token, heartbeats, and throws
`CompleteAsyncError`; the gateway completes it) would have kept the guard
in the loop.

**Fix:** keep one activity per order and complete it asynchronously for
external performers, as §5.5 specifies. If external mode stays, route each
order through the governor as a proposal (a "dispatch" effect), record the
report as its observation, and set the mode per kind from the descriptor's
`performer`.

### VG2: `vet` passes versions admission would refuse, and cannot see open orders

`vet.mjs:152-160` maps polyvers PASS to *auto-upgrade* or *migrate*.

- **VG2:** the new version's mapper posts on entering `review`, skipping the
  approval. polyvers classifies this as the `composition` lane. That lane's
  only real gate, `check-effects`, is *deferred* to polyrun and reported as
  NOT RUN, yet the verdict is still PASS. `vet` never reads
  `report.deferred`, and it never checks that `newDir` carries a valid
  certificate. The gate passes, with every run auto-upgraded, for a version
  `polyflow admit` refuses.
- Probe (not kept as a test): renaming the kind `draft_brief` to
  `compose_brief` in the mapper and manifest is admitted, and `vet`
  auto-upgrades a run in `drafting`. That run's open `draft_brief` order
  completes through the **new** manifest (`host.completion` returns `null`).
  The report is `unwired`, the order is closed, and the run waits forever.
  The cause: `vet` sends polyvers the machine state only, but a run's
  version-relevant state includes its open orders and armed timers. polyvers'
  vocabulary gate checks that old wiring targets still exist as actions. It
  does not check that the kinds of in-flight orders still exist.
- polyvers locates the module as `next.cjs`, then `machine.cjs`, then "the
  only .cjs", and fixed names for everything else. The certificate and the
  worker use the descriptor's paths, so a directory with a stale `next.cjs`,
  or a renamed machine file, is vetted as a different machine from the one
  that runs.

**Fix:**
- Require `checkMachineDir(newDir, trust)` before vetting.
- Fail on any non-empty `deferred` whose gate the certificate does not
  attest to.
- Snapshot `{ state, orders: [{ kind }], timers: [{ key, action }] }`, and
  refuse auto-upgrade when an open kind or armed timer action is missing
  from the new manifest or contract.
- Pass polyvers the certified file set, not the directory.

### VG3: the fleet is the wrong set of runs

`gate-activities.mjs:53-62`:

- The query is `WorkflowType = 'GovernedWorkflow' AND ExecutionStatus = 'Running'`,
  followed by a prefix filter on `polyflow/<machine>/`. The spec (§5.6.1)
  queries `PolyflowCertificate = '<A>'`, but that attribute is never
  upserted.
  - Runs on *other* versions of the machine are vetted against `oldDir`,
    which is not theirs.
  - The returned `certificate` field is ignored by `vet`.
  - Runs started under any other id (the workflow accepts any id) are
    silently skipped: not vetted, not pinned.
- Visibility is eventually consistent, and runs started after the read are
  not in the fleet. That is fine only if new starts land on a deployment
  version, which does not exist (VG1).
- Queries run serially in one activity with no heartbeat, under a 10-minute
  timeout. The full fleet and decisions (every state, twice) travel through
  history as activity input and result, against the 2 MB payload limit.

**Fix:**
- Upsert and query `PolyflowCertificate`.
- Drop the id-prefix filter (the `s.machine` check is enough).
- Refuse runs whose certificate is not `from`.
- Page and heartbeat.
- Keep states in the activity, or a blob store, and pass digests through
  history.

### AB: `--accept-bound` can never certify

`admit.mjs:69,77` set `ok: violations === 0 && !bounded`. `buildCertificate`
(`certificate.mjs:30-33`) throws on any check with `ok === false`, before it
looks at `boundAccepted`. **AB1:** `admit(dir, { acceptBound, maxDepth: 2 })`
throws `cannot certify 'customer-brief': check-effects failed`. From the CLI
the promise rejects past `main`'s `Usage` handler, and the user sees a stack
trace. FR-ADM.2's recorded acceptance cannot be produced.

A bounded *structural* walk is worse. `every-state-can-finish` runs on the
partial graph and reports frontier states as stuck. With `maxStates: 2`,
`idle` and `gathering` are "stuck". So a bounded structural check is a hard
failure whatever the owner accepts.

Also, `boundAccepted` is a bare string. §3.5 specifies `{ by, note }`, with
a principal.

**Fix:**
- Keep `ok` for violations only, and let `bounded` stand on its own.
- In `explore`, mark frontier states `unexplored`, and exclude them from the
  liveness verdict: report "not established", not "stuck".
- Record `{ by, note }`.

### IN: state invariants are certified and never checked

`invariants.mjs` (`stateInvariants`) is among the artefacts (the admit test
asserts it is digested). Nothing evaluates it:

- `admit` runs check-effects (effect invariants) and structural checks only.
- `checkSnapshot` checks keys.
- `migrate` checks nothing.

**IN1:** a state invariant that every non-initial state violates
(`briefState === 'idle'`) is admitted.

The runtime reaches such states too. Report data is not checked against the
contract's field types (below), so `TICKETS_READY { count: -1 }` gives
`drafting` with `ticketCount: -1`, which violates the example's own
`no-work-on-an-empty-brief`.

**Fix:**
- Evaluate `stateInvariants` over every explored state in `admit`, and list
  their names in `guarantees`.
- Check them in `checkSnapshot`, which then covers CaN, `release` and
  `migrate`.

### DEP: the certificate covers files, not the code that runs

`artefactFiles` (`certificates.mjs:13-33`) digests nine named paths. The
machine is bundled by webpack with its whole `require` graph.

**DEP1:**

1. `machine.cjs` requires a local `rules.cjs`, and the machine is admitted
   and signed.
2. `rules.cjs` is then edited so that `APPROVED` jumps straight to `posted`.
3. `checkMachineDir` passes.

The same applies to `@cognitive-fab/sam-pattern`, whose version the
certificate does not record (`toolchain` names polygraph and kernel only). A
dependency upgrade changes machine semantics under an unchanged certificate.

**Fix:** digest the resolved module closure of `machine` and `effects`
(webpack's module list for the generated registry, or `require.cache` after
a fresh load) as a `code` artefact. Record every non-built-in package
version the closure uses. At minimum, refuse relative `require`s outside the
certified set.

### PL: the certified policy is not the enforced policy

`admit` checks `policy.json`, and the certificate names its digest. The
plugin, meanwhile, enforces `new PolyflowPlugin({ policy })` (`plugin.mjs:177`),
whatever that is, and machine loading (`:192-198`) never compares the two.
**PL1:** a machine whose certificate names a policy runs on
`level: 'observe'`, with no policy at all.

**Fix:** when a machine's certificate names a policy, require `level: 'guard'`
with a policy whose digest equals the certified one. For several machines,
require one policy they all name, or give each machine its own governor.

### BV: the build id is not the worker's version

See VG1. **BV1:** `configureWorker({ workerDeploymentOptions: { buildId: 'some-other-build', useWorkerVersioning: true } })`
succeeds for a certified machine whose `buildId()` is `cert-…`.

**Fix:** in `configureWorker`, set the deployment version's `buildId` from
`this.buildId()`, or refuse a different one. Refuse `useWorkerVersioning`
with uncertified machines.

### SA: the workflow never sees `stopAction` or `claimLeaseMs`

`loadMachineDir` (`plugin.mjs:158`) builds the descriptor from `name`,
`description`, `inputAction`, `tools` and `key`. `GovernedWorkflow` reads
`spec.descriptor?.stopAction` (`:120`, the quarantine exit and P2's fix) and
`spec.descriptor?.claimLeaseMs` (`:372`). Both are always `undefined` on
Temporal (**SA1**). So STOP never releases a poisoned run, and every lease
is the 10-minute default.

Separately, `structuralChecks` reports a missing `stopAction` as `ok: null`
("not checked"), and admission passes it. Plan P5.4 says "admission refuses
a machine without it". Neither example declares one.

**Fix:**
- Carry the whole validated descriptor.
- Make `stop-from-every-state` required. A machine without a STOP is refused
  unless the owner accepts that explicitly, and the acceptance is recorded,
  like a bound.

### WT: the structural checks miss the waits that matter

`explore.mjs:164-171`: only edges that emit a `performer: 'human'` kind must
arm a timer in the same step. Tech spec §7.1 says "a state with an open order
and no armed timer on some path is a violation".

- In external mode every order is a wait for an agent that may never come
  back. The admitted customer-brief has three such waits (gathering,
  drafting, posting) with no deadline.
- The check asks only whether *a* timer is armed. It does not ask whether the
  timer's action is accepted in the waiting state. A timer whose action the
  state rejects leaves the run hanging, and admission passes it.
- `every-state-can-finish` counts every action in the domain as an available
  exit, including completions of orders that are not open and actions no
  effect or timer ever produces. So a state that exits only on an
  out-of-band signal nobody sends is "able to finish".
- `domainOf` explores an action with no `dataDomain` entry with `{}` only,
  silently.

**Fix:**
- Compute, per reachable state, the stimuli it actually has: completions of
  the orders open on the path, and the timers armed on it.
- Require each non-terminal state to have a timer whose action is accepted
  there and leads toward a terminal.
- Warn on actions without a declared domain.

---

## Minor

- **GW1: a retryable report stalls 10 s.**
  - A retryable failure report journals a `retry` row at the *same* `seq`.
    `TemporalPolyflow.settle` returns early only when `v.seq > sinceSeq`, so
    `workflow_report { ok: false }` always waits out the 10 s timeout. That is
    the stall the root `makeTools` comment says it avoids.
  - The view it returns drops `settled: false`, so the agent cannot tell.
  - **Fix:** when `actionId` is null, return as soon as the order's `attempt`
    changed, or have `report` return the view itself.
- **A report closes the order even when its completion does not land.**
  - `closeWith` sets the status before stepping. If the machine rejects the
    completion (bad data), or nothing is wired (`unwired`), the order is gone
    and the machine never heard.
  - In external mode with no timer (WT), the run waits forever.
  - **Fix:** dry-run the completion in the validator and refuse the report
    ("fix your result and report again"). Treat `unwired` as a poison, not a
    silent close.
- **Report data is not checked against the contract.** `result` fields
  become action data unchecked: types, ranges, extra fields. The certificate
  is "exhaustive over the declared domains only", and nothing keeps runtime
  data inside those domains. **Fix:** validate `dataFields` types at the
  validator, and journal out-of-domain data as a finding.
- **Who reported is not recorded.** A successful report's journal row has no
  actor. Only `retry` rows carry `by`. **Fix:** record the (unverified)
  actor on every report and claim step, in the journal and the ledger.
- **The uncertified mode is silent.**
  - `allowUncertified: true` runs machines with no check, no log line, no
    ledger field and no search attribute. Only `polyflow.state` shows
    `certificate: null`.
  - Every P4 and P5 test runs this way, the gate test included.
  - The gateway defaults to `trust: null`, which offers every machine as
    `admitted: true`.
  - **Fix:**
    - Write the certificate digest, or `UNCERTIFIED`, into the ledger's
      `admission` event and a search attribute.
    - Log a warning at worker start.
    - Refuse `allowUncertified` when `NODE_ENV=production`, unless an
      environment variable also says so.
    - Have the gateway refuse machines unless `trust` is given or
      `allowUncertified` is set explicitly.
- **`buildId` is not reproducible.**
  - It is digested over a body that includes `issuedAt`, so two admissions of
    the same commit give two versions, and every CI run is a "new version"
    that must be gated.
  - §3.5 is circular: `buildId` is "the first 12 hex of the digest below",
    and that digest covers `buildId`. The code derives it from the body
    without `buildId`, which is sound, but the spec should say so.
  - **Fix:** derive `buildId` from artefacts, checks, domains and toolchain
    only.
- **Gate `apply` robustness.** See MG2, and the payload size under VG3.
- **The gateway's order map lives in process memory.** After a restart,
  `workflow_report` answers `unknown-order` until someone calls
  `workflow_state` on the run. The hint does not say which run. Two gateways
  each learn only the runs they have viewed. **Fix:** encode the workflow id
  in the order id handed to the agent (an opaque `wfid#orderId`), or query
  visibility.
- **FR-AGT.3 and §6.1 gaps.** polycrew's `workflow_next` is not exposed.
  `polyflow.renew` and `polyflow.release` (for claims) do not exist. No lease
  timer is armed (lapse is evaluated lazily, which is deterministic and fine,
  but the spec says a timer). The spec's order table and inbox (§6.2) do not
  exist.
- **Admit: TOCTOU and optional checks.**
  - `artefactDigests` is computed after the checks, so a file edited during
    `admit` is certified unchecked. Read each file once, and check and digest
    the same bytes.
  - Without `policy.json`, "every effect kind has a consequence class" and
    "every irreversible kind is guarded" are skipped, not failed (FR-ADM.5).
  - "Every order role is declared" is not implemented.
- **`polyflow.version` is unauthenticated.** Anyone writes
  `decision: 'pin'` rows into a run's journal.
- **Closed runs in `view`:** the key is not URI-decoded (`:115`), unlike the
  open path (`:129`). A terminated or failed run shows `state: {}`, not its
  last state.
- **A report in worker mode with `ok: false`** re-offers the order while its
  worker activity keeps running.

## Nits

- `hasInvariants` in the gateway catalogue is computed and never used.
- `stop-from-every-state` steps STOP with `{}` data, not the declared domain.
- LF normalisation hashes a file whose string literals contain raw CR bytes
  the same as one without them, even though the two behave differently. The
  case is rare, but the certificate's claim is "these bytes".
- `explore` uses `now: 0` for every step. A machine that reads the clock is
  explored at one instant.

## Test gaps (claims without a test)

- **P4.2** ("one-line edit → worker fails naming the file") is tested on
  `checkMachineDir`, not `Worker.create`. No test starts a worker with
  `trust`: every Temporal test in P4 and P5 uses `allowUncertified: true`.
- **P4.4 / FR-VER.2:** no test has v1 and v2 workers polling at once. None
  shows *pin* or *auto-upgrade* changing anything. None uses a certificate
  build id.
- **P5.2** ("report after CaN lands as a proposal"): no test. CL1 shows that
  a report after a hand-over is accepted, from anyone.
- **P5.4** is not implemented (SA). **P5.5** is not implemented, as the plan
  already says.
- Continue-as-New on `continueAsNewSuggested` (the natural trigger) is
  untested. Every hand-over in the tests is forced by `migrate`.

---

## What held up

- **Certificate tamper evidence.**
  - A byte change in any certified file is refused, naming the file and both
    digests.
  - An edited certificate body is caught by the digest re-check. The
    signature covers a fixed, prefixed message over that digest.
  - Unsigned and untrusted certificates are refused.
  - An optional artefact added after admission (`migrate.cjs`, `policy.json`)
    is refused as "present but not certified".
  - CRLF checkouts hash the same.
- **Admission's verdicts on what it checks.** unsafe-brief is refused with
  the violated effect invariant, and nothing is written. A human wait with
  its timer removed is refused. check-effects is polygraph's, run unchanged.
- **Snapshots from a fresh start are refused.** The S2 fix holds for
  `snapshot` itself (the gap is the other carry fields, FO).
  `checkSnapshot` runs on every hand-over.
- **An empty fleet is refused** by `vet` and by the gate (FR-VER.5), and
  "no runs" has to be said explicitly.
- **`vet` mechanics.**
  - polyvers runs as its own process, once per *distinct* state, and its
    report is kept verbatim.
  - Exit 1 (FAIL) is told apart from a tool failure.
  - The migrated state is carried per run.
  - A PASS with the vocabulary lane does imply no removed actions, and old
    wiring still lands.
- **The gate workflow is deterministic.** All I/O is in activities, and a
  refusal is a non-retryable failure carrying the per-run decisions.
- **Reports.**
  - A duplicate report is refused (`not open`), not executed twice.
  - A report and a worker-side completion share the `${orderId}:done` id, so
    both can never land.
  - The success id matches what the root `makeTools` waits for.
  - Attempt counting and the exhausted fallthrough match polyrun, including
    P2/P3's H2 fix.
- **Claims are decided by the workflow.** Two gateways claiming one order
  get one winner. The loser is told who holds it, as an answer and not an
  error. The holder check on `report` works when a claim exists.
- **The gateway never takes an actor from tool arguments.** The actor comes
  from its own configuration, and `makeTools` passes the host's actor as a
  second argument, never as a schema field. The weak point is the Temporal
  Update boundary (RL), not the MCP surface.
- **The six root tools run unchanged over Temporal.** start → report →
  terminal, the permanent-failure branch, and the finished-run note all
  behave as they do over polyrun.

---

## Response

Every blocker and every major except WT is fixed. Each one has the reviewer's
failing test, which now passes. Some have new tests as well.

| Suite | Result |
|---|---|
| kernel | 68/68 |
| temporal (one file per process) | green, including `review-p4p5-temporal` 9/9, `review-p4p5-vet` 1/1 and the new `versioning.test.mjs` |
| cli | 23/23 P4/P5 tests (the P6–P8 review tests are tracked separately) |
| gateway | 5/5, including GW1 |

| # | Outcome | What changed |
|---|---|---|
| FO | fixed | The carry fields (`snapshot`, `seq`, `orders`, `timers`, `results`, `held`, `previous`, `claims`) are accepted **only** when `workflowInfo().continuedFromExecutionRunId` is set. Any other start that carries one fails at once with `PolyflowSnapshotRefused`, and the error names the fields. `mode` is no longer the caller's choice. The plugin's `externalMode` decides it: `never` (the default), `allowed` or `always`. A start that asks for external mode on a `never` worker is refused. Test adjustment: FO1 and FO2 assumed the forged run would keep going. Refusing it outright is the stronger fix, so both tests accept either outcome and check the refusal message. |
| RP | fixed | `polyflow.report` accepts reports only for **external** orders. An order that a worker activity performs is reported by that activity. An order addressed to a role needs an actor who holds that role. The role is `tool.role`, or `human` for `performer: 'human'`. The gateway's happy-path test now gives its gateway an actor with the `human` role, which is what the finding asked for. Identity is still a claim carried in the payload until P5.5. |
| MG | fixed | `migrate` refuses a quarantined run. It also requires `from`, the digest of the state the migration was computed from, to equal the run's current state (MG2). A same-shape migration must pass `checkSnapshot`, which now also checks every value against its declared contract type. A shape change (`shapeChange`) is checked by the **new** version. If the new version refuses the state, the new run is quarantined holding its previous state rather than failing, and an operator releases it. |
| VG1 | fixed | See the Worker Versioning section below. `versioning.test.mjs` runs two certified versions on two deployment versions, end to end. |
| PC | fixed | `outOfBand` applies the same claim and role rules as `report`. |
| RL | fixed | Role checks are no longer opt-in. An order with a role needs an actor whose `roles` include it. This applies to claim, report and propose alike. |
| MG2 | fixed | `gate.apply` sends the `from` digest. A refused decision counts as `stale`, and the gate carries on with the other runs. |
| CL | fixed | Claims (holder and lease), the dedupe table (the last 200 entries) and held proposals now cross Continue-as-New. The journal does not: it is a per-execution view, and the ledger is the record. |
| GC | fixed | The guard's state travels in `HEAD_HEADER` together with the ledger head, and it is accepted only from a real Continue-as-New. GC1 passes. |
| EX | fixed | An external order crosses the guard when it is issued. The ledger records a proposal, a verdict and an effect (`via: 'external'`), and the report records the observation. A denied order fails through the completion wiring. An order the guard would escalate is refused, with a message saying to model the approval as a step of the machine. |
| VG2 | fixed | `vet` refuses a new version that has no certificate, or whose files are not the ones certified. With `trust`, the certificate must also carry a trusted signature. The change's lanes are still reported. A gate that polyvers defers pins the run, except check-effects, which admission covers. A run with an open order whose kind the new manifest does not know is pinned (`open-orders`). `polyflow vet` takes `--trust` and `--allow-uncertified`. |
| VG3 | fixed, partly | The fleet is filtered by `fromBuildId`. **Deferred to P8:** the `PolyflowCertificate` search attribute (it needs namespace registration), and paging and heartbeats. |
| AB | fixed | `bounded` is now separate from `ok`. Frontier states are marked unexplored, and liveness over them reports `ok: null`. |
| IN | fixed | `stateInvariants` are evaluated over every explored state and named in `guarantees`. |
| DEP | fixed | The certificate covers the transitive closure of local modules (`module:*`). The `sam-pattern` version is recorded in `toolchain`, and the worker checks it. |
| PL | fixed | A machine certified with a policy runs only at `level: 'guard'` with that exact policy digest. |
| BV | fixed | Under Worker Versioning, `configureWorker` refuses a build id that is not `plugin.buildId()`. It also refuses uncertified machines. `buildId` no longer depends on `issuedAt`. |
| SA | fixed | `loadMachineDir` keeps the whole descriptor. Admission requires STOP unless `noStop` is set. `unstoppable` states are declared with a reason and recorded. |
| WT | **deferred to P9** | Per-state stimuli analysis needs the explorer to track open orders along each path. It is scheduled with DST. |
| GW1 | fixed | A retry report advances `seq`. |
| minor: silent uncertified mode | fixed | The worker logs a warning at start. |

### Worker Versioning (VG1)

A governed run never replays across versions. It moves by handing its state,
migrated if needed, to a new execution (Temporal's Upgrade-on-Continue-as-New).

1. **Before promotion.** The gate, with `onVersionChange: true`, vets the new
   version against the runs on `fromBuildId`. Each run that is to move
   receives `polyflow.migrate` together with its state digest, and then
   waits.
2. **Promotion.** The version is promoted. Each worker's deployment build id
   is its certificate's build id.
3. **Wake.** `phase: 'wake'` signals the waiting runs. Each one sees
   `targetWorkerDeploymentVersionChanged` and continues as new with
   `initialVersioningBehavior: 'AUTO_UPGRADE'`.

`versioning.test.mjs` walks through the whole sequence:

- signed certificates, and workers started with `trust` (this closes the P4.2
  test gap);
- a run in `review` that does not move before promotion;
- promotion, then wake;
- the next execution reports v2's build id, and its state and open order are
  carried over;
- v2's `CANCEL` is accepted on a run that started under v1.
