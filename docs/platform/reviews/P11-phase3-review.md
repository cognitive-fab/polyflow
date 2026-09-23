# Review: P11 phase 3 (Temporal's `saga` sample as a certified machine, v2 through vet and the gate)

Adversarial review of commit `378c13c` on `platform/temporal-governance`:

- `platform/examples/temporal_samples/saga/` (the port: `machine/`, `machine-v2/`, `src/`, `upstream.json`, `README.md`, `NOTICE.md`, `package.json`);
- `platform/examples/upstream/samples-typescript@8907f29/saga/` (the pin) and `check.mjs` (`notPorted`);
- `platform/packages/temporal/src/vet.mjs:129` (polyvers' `matrix + product` deferral no longer pins);
- `platform/packages/temporal/src/governed-workflow.mjs:168-200, 361-387` (a proposal's actor on the journal row and as a ledger `proposal` event);
- `platform/packages/kernel/src/explore.mjs:134-146` (`unstoppable-states-refuse-stop`);
- `platform/packages/temporal/test/sample-saga.test.mjs` (eight scenarios), `sample-expense.test.mjs` (c) extended.

The reviewer changed no production code. Every claim below was checked by running it (`check.mjs`, `polyflow admit` on both versions and on the four pre-existing machines, the saga file alone, the full temporal/kernel/cli suites, fifteen admission mutations in throw-away copies, `vet` run programmatically over the test's fleet for v1→v2, v1→v3 and a v2 variant, and one hand-over experiment against the sample with a slow bank activity) or by reading the installed SDK (`@temporalio/*` 1.24.0, polygraph 8.3.0). The certificates `admit` wrote were deleted; the scratch test and copies were removed; the working tree is as it was.

## What was run

| Command | Result |
|---|---|
| `node platform/examples/upstream/check.mjs` | exit 0. saga: nine `identical` (activities, clients, seven type files), three `changed` with their `why`, `not ported package.json README.md`. |
| `polyflow admit platform/examples/temporal_samples/saga/machine` | exit 0. `check-effects paths 17, states 30`, all structural checks ok incl. `unstoppable-states-refuse-stop` (six exceptions), `order-waits-have-deadlines: not checked`. Ten guarantees. |
| `polyflow admit .../saga/machine-v2` | exit 0. `paths 37, states 62`, eight exceptions, same ten guarantee names, `migrate` in the artefact digests. |
| `polyflow admit` on `customer-brief`, `customer-brief-v2`, `refund-triage`, `expense/machine` | all four still admitted with the new check (`unstoppable-states-refuse-stop: ok`). |
| Fifteen admission mutations (table below) | nine refused, **four admitted that should not have been**, one refused by `domain`, baseline admitted. |
| `vet` v1→v2 over the test's fleet plus a seventh run (`adding_bank`, `failAt: 'addBankAccount'`) | `ok`, lanes `shape, migration, composition, vocabulary, intent, semantic`, **7 × `migrate`**, every polyvers report `PASS` (load, vocabulary, invariant-diff, migrate, shape-roundtrip, stimuli 15×1, invariants-pointwise, semantic-model-check 82 states); deferred: `check-effects`, `matrix + product`. |
| `vet` v1→v3 (the test's construction, verbatim) | `ok: false`, **7 × `pin`**: f-2 and f-6 by `open-orders`; f-1, f-3, f-4, f-5, f-7 by `vocabulary` ("action 'ADDRESS_ADDED' was removed") and `stimuli`. Without `openKinds`, all seven pinned by `vocabulary`. |
| `vet` v1→v2′ (v2 with the contract's `phase`/`failedStep`/`failAt` prose NOT widened and no `migrate.cjs`) | v2′ **is admitted**; `vet` → lanes `composition, vocabulary, intent, semantic`, **7 × `auto-upgrade`**. |
| `cd platform/packages/temporal && node --no-warnings --test --test-concurrency=1 test/sample-saga.test.mjs` | exit 0. `tests 8, pass 8, fail 0, todo 0, duration_ms 30071`. (h) 6254 ms. Three `[polyflow] ledger export failed: ledger gap for polyflow/saga/saga-h-1/<first run>: the sink holds through seq -1, this delta starts at 19/22/26` (M5). |
| `cd platform/packages/temporal && npm test` | exit 0. `tests 126, pass 125, fail 0, cancelled 0, skipped 0, todo 1, duration_ms 402082`. The todo is `DST1-R`, as expected. `versioning.test.mjs:118` (phase 2 M7) passed this run. |
| `cd platform/packages/kernel && npm test` | exit 0. `tests 82, pass 82`. |
| `cd platform/packages/cli && npm test` | exit 0. `tests 31, pass 31`. |
| Hand-over experiment (scratch test, removed) | v1 worker's `addBankAccount` sleeps 12 s without heartbeating, then performs the sample's activity; gate vet → promote v2 → wake during the sleep. **`addBankAccount` invoked twice** (0 ms and +2647 ms), the account `opened` on v2 with `addKycCheck` before the v1 call had even returned; then `ADDING BANK ACCOUNT` logged a second time and core warned `Activity not found on completion ... workflow execution already completed` (B1). |
| Dev server | `@temporalio/testing` 1.24.0's cached `temporal-sdk-typescript-1.24.0.exe` = `temporal version 1.9.1 (Server 1.32.0)`. The README's "≥ 1.28" was not exercised at 1.28. |

## Findings

### Blockers

**B1. The hand-over re-executes the step that was in flight on v1: a saga step runs twice, and the README describes this as the run "finishing its bank step on v2".**
`governed-workflow.mjs:633-636` (`handOver`: cancel every open order's scope, `allSettled(inflight)`), `:274` (a cancelled order stays `open`), `:607-611` (carried with the same `intentId`, `payload`, `attempt`), `:318` (re-issued on the new execution), `:54-63` (`retryOf`: no `cancellationType`, so the SDK default `TRY_CANCEL` reports cancellation to the workflow at once), `README.md:69-70`, `test/sample-saga.test.mjs:200-204`.

`handOver` cancels the open order's scope and waits for the in-flight promises; under `TRY_CANCEL` that promise rejects immediately, whether or not the activity on the worker has noticed. The run then continues as new carrying the order *open*, and v2 starts a fresh `addBankAccount` with the same payload. Nothing waits for the v1 attempt to end. The doc comment at `:78-79` says so ("at-least-once, as polyrun re-offers a lapsed lease"), but a lapsed lease is a worker that stopped answering; here the worker is healthy and mid-call.

Verified: with a bank activity that takes 12 s and does not heartbeat (the sample's real activities never heartbeat), the account was opened on v2, KYC passed, and 9 s later the v1 attempt completed its side effect and was refused by the server as `NotFound`. Two `addBankAccount` calls to the bank for one account. Test (h) does not see this because its parked activity heartbeats and observes the cancellation before doing anything.

This is the property a saga exists to protect, and it is exactly the case where Temporal's `patched()` behaves better: a patched v1 run keeps its own activity and its own history; nothing is re-issued. The README's "A run parked in `adding_bank` under v1 finishes its bank step on v2" reads as continuation; it is abandonment and re-execution. The `each-step-at-most-once` guarantee is per execution and is silent about this.

Fix, in order of preference: (1) do not hand over a run with a worker-performed order in flight: `handOver` should wait for open orders to *complete* (`WAIT_CANCELLATION_COMPLETED` on the order's activity, or simply defer the hand-over until `orders` has nothing `open` and a step has just landed, the way `continueAsNewSuggested` is deferred while a migration waits); (2) at minimum, carry the order as `attempt + 1` with an explicit `reissued: true` and make the README say the step is re-executed and must be idempotent for the hand-over to be safe; (3) add a test with a non-heartbeating in-flight step at the hand-over.

### Major

**M1. The certified "compensation discipline" is one-sided: a machine that skips a compensation, or never compensates at all, is admitted with the same ten guarantees.**
`machine/effect-invariants.mjs:10-55`, `machine-v2/effect-invariants.mjs`, `README.md:26-40`, `contract.json:176-181` (`compensate-lifo` is a `specialRule` in prose, not a check).

Every effect invariant forbids a *wrong* emission (a compensation for a step that did not succeed, a forward step after compensating began, LIFO, at most once, in order). None requires a *right* one: nothing says "when a forward step fails, every step that succeeded before it is compensated", and nothing says "`opened` is reached only after every forward step succeeded". Admitted mutations:

- J. `BANK_FAILED → undo_address`: the client is never removed. Admitted, 15 paths, the certificate still lists `compensations-are-lifo` and `compensation-only-for-a-step-that-succeeded`.
- K. `CLIENT_FAILED → failed`: the address is never cleared. Admitted.
- N. (v2) `KYC_FAILED → undo_client`: the bank account is never disconnected. Admitted.
- E. `BANK_ADDED` also accepted from `adding_client`: a stale bank completion opens the account while `addClient` is in flight and `addBankAccount` was never ordered. Admitted, 19 paths; `an-opened-account-has-no-failure` holds because nothing failed.

Failure scenario: an author refactors v2's `forward('adding_kyc', ...)` and drops the bank compensation (N); CI admits it; the README's "what the sample could not say, and the certificate does" is now a certificate for a saga that leaves bank accounts connected. The upstream `for (const comp of compensations)` loop, for all its informality, could not do that.

Add the missing direction: `every-succeeded-step-is-compensated-on-failure` (for each `X_ADDED` before a `*_FAILED`, the matching undo kind is emitted after it, on every path ending `compensated`/`compensation_failed`, or the compensation chain is broken by a named `compensation_failed`) and `opened-only-after-every-step` (`opened` reached ⇒ every forward kind emitted and its `*_ADDED` before). Both are a few lines in the same style as the existing ones, and mutation tests J/K/N/E should join scenario (b).

**M2. STOP is accepted from `idle` only, and `idle` is left in the run's first step: no reachable state of a live run accepts a person's stop.**
`machine/machine.cjs:109-116`, `machine/polyflow.workflow.json:20-28` (six exceptions, eight in v2), `governed-workflow.mjs:316` (`START` at start), `:54-63` (`startToCloseTimeout` only, no `scheduleToClose`), manual §3.1 (`stopAction`: "the action a person uses to stop the run"; `unstoppable`: exceptions "recorded in the certificate").

`stop-from-every-state: ok` and `unstoppable-states-refuse-stop: ok` are both true, and together they say: every non-terminal state a run can be in is declared unstoppable, and the machine indeed refuses `STOP` in all of them. The certificate's stop property holds vacuously. The reasons given ("a step is in flight: the saga ends by its own outcome") assume the step ends. It does not always: an order is an activity with `startToCloseTimeout` and bounded attempts, but no `scheduleToCloseTimeout`; with no worker polling the queue (a deploy gone wrong, a queue renamed) the activity never starts, never times out, and the run sits in `adding_bank` forever, refusing `STOP` with `nothing-to-stop`. An operator's only exit is Temporal's terminate, outside the record.

The expense port declared one state unstoppable, for an irreversible payment. Here the mechanism designed for one irreversible step is used to exempt the whole machine. Either (a) accept `STOP` in forward states and let it run the compensations (a stop *is* a failure at the current step: `STOP` in `adding_bank` → `undo_client`, the natural saga semantics, and what upstream would do on a workflow cancellation caught by its `catch`), keeping only `undo_*` unstoppable; or (b) have admission refuse an `unstoppable` set that covers every reachable non-terminal state, since then the stop action is decoration. (a) is the honest port.

**M3. The v3 story is not what vet does: every run is pinned, not "the runs parked in" the removed step; and the v2 `migrate` decision is a ceremony triggered by prose.**
`README.md:63-65`, `test/sample-saga.test.mjs:177-178` (asserts only that f-2 and f-6 are *among* the pinned), `vet.mjs:95-108, 113-137`, polyvers `classify.mjs:71-90` (`diffShape` compares `stateKeys[].type` strings), `machine-v2/contract.json:6,14,35`, `machine-v2/migrate.cjs`.

v1→v3: f-2 and f-6 are pinned by `open-orders` before polyvers runs; the other five are pinned by the `vocabulary` gate ("action 'ADDRESS_ADDED' was removed — in-flight stimuli from the old version can still deliver it") and by `stimuli`, both of which are properties of the *change*, not of the state. So vet's per-state granularity buys nothing here: a run in `creating_account`, which will never see `ADDRESS_ADDED` on v3, is pinned with the same reason as one parked in `adding_address`. The README's sentence promises a state-aware verdict the tool did not give. Either say "a v3 that removes an action is pinned fleet-wide (vocabulary), and the runs with open orders for it are pinned by name" or make the test assert `counts.pin === FLEET.length` so the sentence cannot drift from the tool.

v1→v2: all seven decisions are `migrate`, because the `phase` enum in `contract.json` is a prose string that changed, which polyvers reads as "the sealed state shape changed" and which demands `migrate.cjs`. `migrate.cjs` is the identity (verified pure and projection-equal by polyvers, correctly). The reviewer's v2′, identical to v2 except that the three prose enums were left as v1's and `migrate.cjs` deleted, **is admitted** (admission does not check the contract's enum against the phases the machine reaches) and vets as 7 × `auto-upgrade`, with the same runtime behaviour. So "every v1 state comes back `migrate` (the enum widened)" is true, and it means: the operator edited a comment. Worth saying plainly in the README, and worth a kernel check that the `enum:` prose of the terminal key covers the reachable values of `phase`, so that the prose is load-bearing in both directions.

**M4. The README's `patched()` contrast omits the one thing `patched()` guarantees and this design does not: an old run keeps its old behaviour.**
`README.md:46-70`; `governed-workflow.mjs:645` (`initialVersioningBehavior: 'AUTO_UPGRADE'`).

`patched('kyc')` on a v1 run returns `false` forever: the run finishes without KYC, by construction, and the operator's decision is "new runs get KYC". Here a v1 run in `adding_bank` gets KYC, because the migrated state lands on v2's machine and v2's `BANK_ADDED` leads to `adding_kyc`. That is a *behavioural* migration of in-flight runs, chosen by whoever promoted v2 on the strength of vet's report (which checks that v2 can hold and step the state and that invariants hold, not that the customer who started under v1 agreed to KYC). It may well be the right choice; the README should say that it is a choice, that `patched()` makes the other one, and that vet's `PASS` is "v2 accepts this state", not "v2 treats this run as v1 would". "Four worker stages, no proof that the new branch is safe" is a fair criticism of `patched()`; "no `patched()`" is not by itself an improvement when it also means "old runs take new business steps".

Two smaller accuracy points in the same section: upstream's `openAccount` *throws* after compensating (a failed workflow, `client.ts` exits 1); the port ends `compensated` as a successful completion and `client.mjs` exits 0 printing "account not opened". That is a reasonable design (the outcome is state) but it is a change the table at `README.md:16-22` does not list. And "swallowing any error a compensation raises" (`README.md:6-7`, `:41-44`) is correctly contrasted, but the port also retries compensations five times (`effects.manifest.json:36,43`) where upstream retried within a 3 s `scheduleToClose`; the manifest's `timeoutMs` is `startToClose` per attempt, so a compensation may take 5 × 3 s plus backoff. The "Failure injection" note could carry the timeout mapping.

**M5. The record does not survive the hand-over in the test's own configuration, and nothing notices.**
`test/sample-saga.test.mjs:207` (a fresh `memorySink()` per versioned worker), the three `ledger export failed: ledger gap ... the sink holds through seq -1, this delta starts at 19` lines in the (h) run; `workflow-interceptors.mjs` (the exporter refuses a delta whose predecessor it never saw, correctly).

After the hand-over, every flush from the v2 execution is refused by v2's sink because the chain's first 18 events went to v1's sink. The v2 half of `saga-h-1`, the half with the migration, the re-issued order and the KYC step, is exported nowhere; (h) asserts state and history and passes. In production the two workers would normally share a sink directory, so this is a test artefact; but the flagship "hand-over with its record" scenario should assert the ledger is continuous (`sink.read(...)` across the run ids, as expense (c) now does for one run), with one shared sink, and the exporter's refusal should fail a test rather than print. Fourteen such lines appear across the full suite.

### Minor

**m1. "Loaded as is" is loaded through `transform` mode plus synthesised exports; honest in `loader.mjs`, understated in the README.**
`src/loader.mjs:25-35`, `README.md:18`. Node's default strip mode refuses `src/types/post-office-client.ts` ("import equals declaration is not supported in strip-only mode"); the hook uses `stripTypeScriptTypes(..., { mode: 'transform' })`, which rewrites `import X = Commands.X` to `const X = Commands.X`, and then appends `export let Name;` for every erased `export interface|type`, so `clients/index.ts` gains a live `BoundedContextClients` binding (`undefined`) and every type module gains bindings ts-node never had. No runtime behaviour of the sample changes (verified: `makeActivities()` yields the seven sample activities plus `addKycCheck`, all bound to the sample's clients). The regex misses `export declare`, `export abstract class`, `export enum` (transform mode keeps enums), `export type { X }` re-exports, and a file that exports both `type Foo` and `const Foo` would get a duplicate declaration; fine for this sample, worth a comment. Say "Node's TypeScript transform (not the default strip mode) with erased-export shims" in the README table.

**m2. `src/orders.mjs` is faithful; `effects.manifest.json`'s `payloadSchema` is not read by anything.**
`orders.mjs:12-20`, `effects.cjs:10-11` (`shouldThrow` added to a payload whose declared schema has no such key). `createActivities(await createClients())` is upstream's `worker.ts:10-11` verbatim. `grep -r payloadSchema` over `kernel/src`, `temporal/src`, `cli/src` and polygraph finds no reader: the schemas are documentation. Either check them at admission (the mapper's emitted payload keys against the declared schema, which would have flagged `shouldThrow`) or drop the key so the manifest does not look like a contract it is not.

**m3. `failAt` turns the sample's hard-coded demo failure into a production input of the certified machine, and the acceptor does not bound it.**
`machine.cjs:89-96` (`failAt: failAt || ''`, any string), `contract.json:35` (the enum is prose), `client.mjs:38`. Upstream's `shouldThrow` was set inside the workflow; here any client with the workflow id can start a run that creates the account, adds the address and the client, then fails the bank step on purpose and compensates. Mutation O shows `admit` refuses a domain value outside the enum, but at run time `failAt: 'nonsense'` is accepted and simply never matches. In v2 the third domain entry (`failAt: 'addKycCheck'`) doubles exploration (17 → 37 paths) while no invariant reads a payload; its only effect is the stimuli superset polyvers replays. If the injection is kept, validate it in the acceptor (reject `bad-fail-at`) and say in the README that it is a client-controlled input.

**m4. Scenario (h) asserts less than the README says.**
`test/sample-saga.test.mjs:250, 259-260`. "The parked order was re-issued on v2" checks `kind` only; the code does carry the same order id and payload (`carryArgs` → `order(e)`, verified: orderId `d9a2…` identical, `attempt: 1`), so assert them. "Exactly one continue-as-new" is `events.some(...)` on the first run; add "none on the second". Worker Versioning is in effect (`defaultVersioningBehavior: 'PINNED'`, the run stays on v1 until `setCurrent(w2)`, and `certificate.buildId === w2.buildId` after); without it the AUTO_UPGRADE continue-as-new would land on whichever worker polled first, so the test would be flaky rather than red. A `describe().versioningInfo` assertion on both runs would make the property explicit.

**m5. The `matrix + product` exemption is sound for this host, but it is a hard-coded string match on a gate name, and it is not where the cross-version hazard lives.**
`vet.mjs:129`, `machine-host.mjs:258-259` (`spawnChild`/`signalChild` poison), `explore.mjs` (`no-poisoned-steps` refuses a poisoned path: verified by reading). The reasoning holds: no admitted mapper can emit a child intent, so no fleet has children. But (a) the regex would silently keep exempting if a future host added `spawnChild` support, so key it on a host capability (`host.supportsChildren === false`) rather than on prose; (b) the hazard the reviewer was asked about, a v1 activity landing on v2, cannot happen at the workflow level (the completion is addressed to the closed v1 execution and the server refuses it, observed as `Activity not found on completion`), and the hazard that *does* exist (B1) is one neither `matrix` nor `product` would check. `check-effects` remains the only deferred gate covered by something (admission).

**m6. The proposal record: roles are unfiltered, a Signal proposal is recorded twice, and `source` is decided by the order, not the actor.**
`governed-workflow.mjs:381-385`, `workflow-interceptors.mjs:445-449`. Without `principals`, `by.roles` is the caller's array as sent (objects, any length) and goes into the signed ledger; `principalClaims` filters strings for the verified path, do the same here and cap it. A `polyflow.propose` Signal appends a `proposal` in `handleSignal` (`action: 'polyflow.propose'`) and then again in `propose()` (`action: 'APPROVE'`): two events for one act (by reading; the suite does not assert ledger counts for signals). An operator's `STOP` by Update names no order, so it is recorded as `source: 'agent'`. The record is replay-safe (`append` is deterministic, returns `null` after closure, and `propose` runs only inside handlers that `handOver` waits for), and `by` carries no token or note.

**m7. `unstoppable-states-refuse-stop` steps the stop action with `{}`.**
`explore.mjs:139`. A machine whose `STOP` acceptor requires data would be "refused" everywhere and pass the check vacuously; step with the descriptor's declared stop data, or the first domain value, as `stop-from-every-state` should too. All four existing machines still admit, so nothing regressed.

**m8. `src/worker.mjs`'s header contradicts its own path resolution.**
`worker.mjs:1` says `[./machine | ./machine-v2]`; `:13` resolves `argv[2]` against `import.meta.url`, so `./machine-v2` becomes `src/machine-v2` and the worker fails to load. The npm scripts pass `../machine-v2/` and work (`start.v2` → `saga/machine-v2/`, default → `saga/machine/`). Resolve against `process.cwd()` or fix the comment. `client.mjs:13` always loads v1's descriptor, which is fine (only `name` and `key` are used) but worth a comment.

**m9. `upstream.json` cannot say which port files are new.**
`src/loader.mjs`, `src/register.mjs`, `src/orders.mjs`, `machine/`, `machine-v2/` derive from nothing upstream and appear nowhere in the manifest; `notPorted` covers the other direction only. A `new: [...]` list would make the table the whole story, as phase 2's m1 asked.

**m10. Small README points.** `README.md:66` "dev server ≥ 1.28" ran only on Server 1.32.0 here. `:69` "exactly once" is per run of the gate's `wake`, and a second `wake` finds `migrationPending` null after the hand-over (`carryArgs` does not carry it when upgrading), so it is true; say "at most once per promotion". `:85` "eight scenarios" is right. `:94-97` is accurate about `matrix + product`.

## Admission mutations (all in throw-away copies, deleted)

| Mutation | Expected | Result |
|---|---|---|
| baseline v1 | admitted | admitted, 17 paths / 30 states, 10 guarantees |
| A. compensation before its step: `CLIENT_FAILED → undo_client` (scenario b) | refused | refused, `compensation-only-for-a-step-that-succeeded` |
| B. forward step after compensating began: `CLIENT_REMOVED → adding_bank` | refused | refused: check-effects, and `state-invariants` |
| C. LIFO reversed: `BANK_FAILED → undo_address → undo_client → compensated` | refused | refused: check-effects (`compensations-are-lifo`) |
| D. a compensation emitted twice: `removeClient` also on entering `undo_address` | refused | refused: check-effects (`each-step-at-most-once`), `every-wait-has-an-exit` |
| E. a stale completion accepted: `BANK_ADDED` also from `adding_client` → `opened` | should be refused | **admitted** (M1) |
| F. a step skipped: `ADDRESS_ADDED → adding_bank` | refused | refused: check-effects (`forward-steps-in-order`) |
| G. `STOP` accepted from `adding_bank` (declared unstoppable) | refused | refused: `unstoppable-states-refuse-stop` (phase 2 M6 fix works) |
| H. a wait with no order: nothing emitted on entering `adding_client` | refused | refused: `every-wait-has-an-exit` |
| J. a compensation skipped: `BANK_FAILED → undo_address` | should be refused | **admitted**, 15 paths (M1) |
| K. no compensation: `CLIENT_FAILED → failed` | should be refused | **admitted**, 15 paths (M1) |
| L. the bank failure opens the account: `BANK_FAILED → opened` | refused | refused: `state-invariants` (`an-opened-account-has-no-failure`, because `failedStep` is set) |
| M. v2: `BANK_FAILED → undo_bank` (disconnect a bank never added) | refused | refused: check-effects (`compensation-only-for-a-step-that-succeeded`) |
| N. v2: `KYC_FAILED → undo_client` (bank never disconnected) | should be refused | **admitted**, 34 paths (M1) |
| O. `failAt: 'nonsense'` in the domain | refused | refused: `domain` (the enum prose is enforced for domains only) |

No effect invariant is vacuous on the baseline (each refuses at least one mutation above); the gap is what they do not say (M1).

## What is right

- **The byte-identical claim is honest and mechanical.** Nine files match byte for byte, `check.mjs` refuses drift in both directions and now names what was not ported, `NOTICE.md` names the MIT origin and the commit. `orders.mjs` calls `createActivities(await createClients())` exactly as upstream's `worker.ts` does; the order payloads are the sample's commands, so the activity inputs in history are upstream's shapes.
- **The machine is a faithful rewrite of `workflows.ts`** where it claims to be: four steps in order; `createAccount` and `addAddress` failures compensate nothing (`failed`), a client failure clears the address, a bank failure removes the client then clears the address; compensation errors are surfaced as `compensation_failed` and the README says so; `removeClient` before `clearPostalAddresses` is a proved guarantee; `disconnectBankAccounts` is registered but unused in v1, as it is unreachable upstream.
- **v2 is a clean widening with an honest migration.** The KYC step and `undo_bank` slot into the same `forward`/`compensation` constructors; `migrate.cjs` is the identity and polyvers validates it pure and projection-equal; a v1 run in `adding_bank` does get `addKycCheck` on v2 (scenario h and the reviewer's experiment both show it); mutation M shows the v2 invariants catch a compensation for the new step's predecessor.
- **The hand-over carries what it says.** The same order id, payload and attempt are re-issued on the new execution (verified in the state query); a v1 completion cannot double-apply at the workflow level (Temporal refuses it against the closed execution); the run stays on v1 until v2 is current; `AUTO_UPGRADE` on the continue-as-new lands it on v2 and the certificate's build id proves which machine answered. The blocker is what happens to the work, not to the state.
- **`vet` reports are verbatim and readable**: lanes, every gate with its summary, deferred gates with their reasons; the `open-orders` pre-check names the orphaned kind. The v3 pin is real and the gate refuses to promote.
- **The phase 2 fixes land as described.** Expense (c) asserts `by` on the journal row and a `source: 'human'` proposal event with the principal; `unstoppable-states-refuse-stop` refuses mutation G and admits the four existing machines; the axios/express bump and the licence-audit row are in the diff; `ledger/` is ignored.
- **The suites are green on this machine**: temporal 126 (125 pass, 1 todo `DST1-R`), kernel 82/82, cli 31/31, saga 8/8, and the phase 2 `versioning.test.mjs:118` race did not reproduce this run.

## Response (same session)

| Finding | Action |
|---|---|
| B1 the hand-over re-executes the step in flight | **Fixed in the host.** Orders are scheduled with `WAIT_CANCELLATION_COMPLETED`, so `handOver` calling them off actually waits: an activity that heartbeats stops and is carried open (re-issued under the same id and payload); one that does not runs to its end and its completion is stepped on the old version. If the run has then moved past the state the gate vetted, the hand-over is abandoned with `migration-stale` on the journal and the run stays on v1 for a re-vet (before, `carryArgs` handed the moved-on state to v2 unmigrated). Scenario (i) reproduces the reviewer's case with a 3 s non-heartbeating `addBankAccount`: invoked once, `opened` on v1, no KYC, one effect in the chain. `retry.heartbeatMs` (manifest, documented) sets the activity's heartbeat timeout, which bounds how soon a cancellation reaches a parked order. |
| M1 one-sided compensation discipline | **Fixed.** Two effect invariants (`no-completion-without-its-order`, `every-succeeded-step-is-compensated-first`) and two state invariants (`failed-only-when-nothing-to-compensate`, `compensation-is-for-a-later-step`) on both versions. Mutations J, K, N and E are now refused by name (re-run in this session, plus the STOP-from-`adding_bank` one); scenario (b) carries two of them. |
| M2 STOP vacuous | **Fixed.** `STOP` is accepted from `idle`, `creating_account` and `adding_address` (the steps that register no compensation upstream either); `CANCEL` compensates what succeeded from `adding_client`, `adding_bank` (and `adding_kyc`), ending `compensated` with reason `cancelled`. The remaining `unstoppable` states are the compensating ones and the ones a stop would leave un-compensated, each with a reason that names `CANCEL`; admission checks they refuse `STOP`. Scenario (j). |
| M3 vet v3 pins everything; prose enum drives `migrate` | **Fixed** in the test (all seven pinned asserted, `open-orders` for the two parked in the removed step) and stated in the README: the vocabulary gate pins every run for a removed action; the identity migration is what the widened prose makes it, an `auto-upgrade` otherwise, same behaviour. |
| M4 README vs `patched()` | **Fixed.** The README now says this is a behavioural migration the operator accepts on vet's report, not equivalence, and states the two rules that make it safe (a step in flight finishes where it started; one chain). It also lists `compensated` as a result where upstream fails the workflow, and the retry difference. |
| M5 (h) ledger gaps across the hand-over | **Fixed.** One sink for both workers; (h) asserts the chain verifies across the hand-over, closures `continued-as-new` then `completed`, and the bank order once on each side. |
| m loader wording | **Fixed** (README: Node's TypeScript transform, extensionless imports, a binding per erased export). |
| m `payloadSchema` unread | Open (kernel: nobody validates order payloads against it). Carried. |
| m `failAt` unbounded | **Fixed** (the acceptor refuses unknown values) and documented as the sample's test hook. |
| m signal proposals recorded twice | **Fixed** (`propose` records the ledger proposal for Updates only). |
| m `by.roles` from unverified claims; source by order role | Accepted: the claim is recorded as a claim (`verified: false`); the source says whose order it answered. |
| m explore steps STOP with `{}`; hard-coded gate-name regex; header comment path; dev server version | Accepted; the README no longer states a dev-server version. |
