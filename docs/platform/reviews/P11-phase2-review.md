# Review: P11 phase 2 (Temporal's `expense` sample as a certified machine, G2/G3)

Adversarial review of commit `443681d` on `platform/temporal-governance`:

- `platform/examples/temporal_samples/expense/` (the port: `machine/`, `src/`, `upstream.json`, `README.md`, `NOTICE.md`, `package.json`);
- `platform/examples/upstream/samples-typescript@8907f29/` (the pin) and `check.mjs` (`root` now joins the upstream path);
- `platform/packages/temporal/src/governed-workflow.mjs:347-352` (`outOfBand` refuses a by-hand completion of a worker-performed order);
- `platform/packages/temporal/test/sample-expense.test.mjs` (nine scenarios);
- `platform/package.json` workspaces, `platform/package-lock.json` (axios, express), `.gitignore`.

The reviewer changed no production code. Every claim below was checked by running it (`check.mjs`, `polyflow admit`, the full `npm test`, the expense file alone, nine admission mutations in throw-away copies, one worker-restart experiment against the sample) or by reading the installed SDK (`@temporalio/*` 1.24.0, polygraph 8.3.0) and the upstream repository listing at the pinned commit. The certificate `admit` wrote into the sample was deleted afterwards; the scratch test and copies were removed.

## What was run

| Command | Result |
|---|---|
| `node platform/examples/upstream/check.mjs` | exit 0. `identical src/activities.ts`; `changed` for the five declared files with their `why`. The Python port (`root: "."`) still resolves under the new `join(here, source, root)`. |
| `node platform/packages/cli/bin/polyflow.mjs admit platform/examples/temporal_samples/expense/machine` | exit 0. `domain ok`, `check-effects paths 9, states 12, bounded false`, structural: `every-state-can-finish`, `state-invariants`, `waits-on-people-arm-timers`, `stop-from-every-state` (exception `paying`), `every-wait-has-an-exit`, `no-poisoned-steps` ok; `order-waits-have-deadlines: not checked`. `ADMITTED expense as cert-a2ac2393df12 (UNSIGNED)`. Nine guarantees: the six effect invariants and the three state invariants. |
| Nine admission mutations (below) | six refused by name, one crashed `admit`, two admitted (one of them should not have been). |
| `cd platform/packages/temporal && npm test` | **exit 1.** `tests 118, pass 116, fail 1, cancelled 0, skipped 0, todo 1, duration_ms 531760`. The todo is the expected `DST1-R`. The failure is `versioning.test.mjs:118` "a gated run waits on v1, and continues as new onto v2" (see M7). All nine expense scenarios pass inside the suite. |
| `node --no-warnings --test --test-concurrency=1 test/sample-expense.test.mjs` | exit 0. `tests 9, pass 9, fail 0, todo 0, duration_ms 29872`. (a) 790 ms, (b) 22 ms, (c) 4138 ms, (d) 12667 ms, (e) 2535 ms, (f) 2034 ms, (g) 2606 ms, (h) 2672 ms, (i) 110 ms. |
| `node --test test/versioning.test.mjs` (alone, twice) | fails both times at the same assertion (M7). |
| Worker-restart experiment (scratch test, removed) | start a run, wait for the `request_approval` order, `worker.shutdown()` gracefully, start a second worker on the same queue: **1.5 s later the run is `{ expenseState: 'rejected', reason: 'approver-unreachable' }`**, no open orders, journal tail `REJECT accepted (source: order)`; the approver's `APPROVE` gets "workflow execution already completed" (B1). |
| `cd platform && npm audit --omit=dev` | 8 advisories (3 high, 2 moderate, 3 low), all through the sample's `axios@0.28.1` and `express@4.20.0` (M5). |
| Upstream listing at `8907f29` (GitHub contents API) | `expense/` has `.eslintignore .eslintrc.js .gitignore .npmrc .nvmrc .post-create .prettierignore .prettierrc README.md package.json tsconfig.json src/`; `src/` has exactly `activities.ts worker.ts workflows.ts clients/ server/` (no tests). |

## Findings

### Blockers

**B1. A worker restart during the approval window rejects the expense.**
`platform/examples/temporal_samples/expense/src/orders.mjs:25-31`, `machine/effects.manifest.json:10-16`, `platform/packages/temporal/src/governed-workflow.mjs:54-63` (`retryOf`), `:266-281` (`order`).

The person's request is "the request's presence on the worker": an activity that parks and heartbeats. Its manifest entry says `retry.maxAttempts: 1`, `onFailure → REJECT { reason: 'rejected' }`, `onExhausted → REJECT { reason: 'approver-unreachable' }`. So the request's *presence* has become the request's *outcome*: anything that ends the activity other than the run calling it off is a person saying no.

Verified failure scenario: run started, `request_approval` parked on worker 1, worker 1 shut down gracefully (a deploy), worker 2 started. The SDK cancels the parked activity on shutdown, the activity completes as failed (not as a server-requested cancellation, so `isCancellation` at `:274` is false), attempt 1 of 1 is exhausted, and `:277` steps `REJECT { reason: 'approver-unreachable' }`. The run is terminal `rejected` 1.5 s after the restart. The manager who was about to approve gets "workflow execution already completed". Nothing retries the request, because `maxAttempts: 1` was chosen precisely so that a real "no" would not be retried.

A hard crash (`kill -9`) is the same outcome on a delay: the activity has no `heartbeatTimeout` (`retryOf` sets only `startToCloseTimeout`), so the server notices nothing until `timeoutMs` (300 s) elapses, then times the attempt out, and the same `onExhausted` rejects. In this sample the 10 s timer wins that race, which is why none of the nine scenarios sees it; with any window longer than five minutes the timeout wins, and the rejection lands with a healthy approver.

Upstream has none of this: the wait is workflow state (`wf.condition`), it survives any number of worker restarts, and the signal arrives whenever it arrives. The port's headline shape, "a person's order", regresses the one property the sample's shape had.

Fixes, in order of preference: (1) do not model the request as an activity at all in worker mode: a `performer: 'human'` order should be a *waiting* order (like external mode's `o.ledger` path, `:248-258`) that schedules nothing and is closed by `propose`/`report`, with the timer as its only exit; (2) if the parked activity must exist as a presence signal, its completion must never step the machine: the manifest for a human kind should have no `onFailure`/`onExhausted` (admission can require that), and a cancelled or failed presence should re-park (`maxAttempts` unbounded, `heartbeatTimeout` set) while the order stays `open`; (3) at minimum, `onFailure` for `request_approval` must not be `REJECT { reason: 'rejected' }` (see M4). Add a test that restarts the worker mid-window and then approves.

### Major

**M1. The approval decision, and who made it, is not in Polyflow's record at all.**
`governed-workflow.mjs:158-161` (`record`), `:197-200` (the step record has no actor), `:361-376` (`propose` uses `actor` only to refuse), `workflow-interceptors.mjs:444-450` (only *signals* are appended to the ledger, as `proposal` with a digest); `README.md:24-28`.

The README's contrast is "the signal carries no identity". In the port the Update carries `actor: { id: 'manager', roles: ['human'] }`, the validator checks the role claim, and then `step()` records `{ seq, action: 'APPROVE', data: {}, source: 'update', ... }` with no actor. The ledger (sink) receives nothing for an Update at all: `handleSignal` appends signals, there is no `handleUpdate`/`validateUpdate` interceptor (the SDK has both, `@temporalio/workflow/lib/interceptors.d.ts:55,59`), and the machine's steps are not exported anywhere. Temporal's history retains the Update input, exactly as it retained the signal upstream, so the port has *not* moved "who approved" from Temporal into the record; it added a claim check in front of the same history.

Failure scenario: an auditor asks the ledger who approved `my-business-id`. The ledger shows `createExpense`, `request_approval` and `payment` effects. The journal query (in-memory, 500 entries, replayed from history) shows `APPROVE` from `source: 'update'`. Neither names `manager`. With `principals` configured the token is verified in the validator and then dropped the same way. Record `{ id, verified }` on the step (as `polyflow.claim` already does at `:478`), append proposals made by Update to the ledger the way signals are, and say in the README that without `principals` the role is a claim (the plugin already warns so at `plugin.mjs:305`; the README's "an actor without the role ... is refused" should say "an actor that does not *claim* the role").

**M2. The certified approval window is not the effective one: `timeoutMs` in the manifest caps it silently.**
`effects.manifest.json:15` (`timeoutMs: 300000`), `effects.cjs:9` (`APPROVAL_WINDOW_MS`), `governed-workflow.mjs:57`.

`retryOf` turns `timeoutMs` into the activity's `startToCloseTimeout`. For the parked presence that is a second, uncertified window of 5 minutes: after it, attempt 1 of 1 is exhausted and the run rejects with `approver-unreachable`, approver or no approver. The README says the window is "part of the certified machine" and "upstream's default"; admission's `waits-on-people-arm-timers` checks that *a* timer exists, not that it is shorter than the presence's timeout. Failure scenario: an operator raises `APPROVAL_WINDOW_MS` to a business day, re-admits (passes), deploys; every expense not approved within five minutes is rejected as unreachable. Either the manifest for a human kind must declare no timeout (the timer is the deadline; admission should refuse a human kind with `retry.timeoutMs`), or admission must check `timeoutMs >= fireInMs` for every step that emits a human kind and a timer.

**M3. A pending approval costs a worker activity slot for the whole window, and the slot is not freed promptly when the run moves on.**
`orders.mjs:28-31`, `governed-workflow.mjs:57` (no `heartbeatTimeout`), `@temporalio/worker/lib/worker-options.js:181-182` (`defaultHeartbeatThrottleInterval: '30s'`, `maxHeartbeatThrottleInterval: '60s'`).

Each parked `request_approval` occupies one of the worker's `maxConcurrentActivityTaskExecutions` (default 100) for as long as the window. With a realistic window and 100 pending expenses, the worker cannot run `createExpense` or `payment` for anyone: approved runs wait on `paying` because the payment activity cannot start. Cancellation is delivered through heartbeat responses; with no `heartbeatTimeout` the SDK throttles heartbeats to the default interval, so after the run calls the order off (approve, timeout, STOP) the parked activity keeps its slot until the next flushed heartbeat, and after the run *completes* until the heartbeat fails with not-found. Test (h) asserts `activityTaskCancelRequested` (the request), not that the activity ended. This is a design cost of "presence as an activity" that the README's "Two things to know" does not name. Same fix as B1 (1); short of that, set `heartbeatTimeout` on human kinds and document the slot cost.

**M4. An infrastructure failure of the request is recorded as a person's rejection.**
`effects.manifest.json:13`, `machine.cjs:59-64`, `contract.json:28`.

`onFailure` for `request_approval` is `REJECT { reason: 'rejected' }`: a non-retryable throw in the presence activity (a bug, a `PolyflowDenied` from a policy, a worker cancelling on shutdown as in B1) produces exactly the state a manager's `REJECT` produces, `{ expenseState: 'rejected', reason: 'rejected' }`. The only distinguishing bit is `source: 'order'` vs `'update'` in the in-memory journal. Verified through the host: `completionAction('request_approval', 'permanent', ...)` → `{ action: 'REJECT', data: { reason: 'rejected' } }`. A person's answer and a machine's failure must not share a domain value; at minimum use a third reason and make the human `REJECT` require its own.

**M5. The sample brings `axios@0.28.1` and `express@4.20.0`, and with them eight advisories, into the platform lockfile.**
`package.json:20-21`, `platform/package.json:8` (workspaces), `platform/package-lock.json`; `docs/platform/reviews/P9-licence-audit.md:19-21`.

`npm audit --omit=dev` in `platform/` now reports axios (high: SSRF/credential leak via absolute URL GHSA-jr5f-v2jv-69x6, prototype-pollution and DoS families, fixed in 0.30+/1.x), express 4.20.0 → `path-to-regexp@0.1.10` (high, ReDoS, GHSA-rhx6-c78j-4q9w), `body-parser@1.20.3`, `qs@6.11.0` (moderate), `cookie@0.6.0`, `send@0.19.0` (low). Licences are all MIT/BSD, so NFR-10 holds; but the P9 audit's scope line ("npm, Temporal-facing ... 168 entries") is now stale, and any CI `npm audit` on the platform is red. The versions were copied from upstream's `package.json` for no functional reason: `activities.ts` uses only `axios.post(url, body)`, which is unchanged in axios 1.x, and `server.mjs` uses nothing express 4.21 changed. Bump both (`axios ^1.7`, `express ^4.21`), note in `upstream.json` that the port's `package.json` diverges from upstream's and why, and add a line to the licence audit naming the sample workspace as private and unshipped.

**M6. `unstoppable` is an exemption from the stop check, not a check that the state is unstoppable.**
`machine/polyflow.workflow.json:31-33`, `platform/packages/kernel/src/explore.mjs:121-132`, `README.md:52-53`.

Mutation H (below) lets `STOP` be accepted from `paying`; admission passes and the certificate still says `stop-from-every-state: ok, exceptions: { paying: "the payment is in flight: stopping would not unpay it" }`. The README states the property ("`STOP` ends the run from any state but `paying`") as if the certificate proved it. Failure scenario: a later edit accepts `STOP` in `paying`; the terminal step cancels the `payment` order's scope (`governed-workflow.mjs:214`) while the POST may already be in flight; the server says COMPLETED, the run says `stopped`. Admission should check that the declared `stopAction` is *rejected* in every `unstoppable` state (the exemption then means "we checked it cannot be stopped", which is what the word says).

**M7. `npm test` on the branch is red: `versioning.test.mjs:118` fails, 3 of 3 runs.**
`platform/packages/temporal/test/versioning.test.mjs:113-118`.

After `until(runId !== firstRun)` the test describes the run at once and reads `deploymentVersion.buildId`; the failing describe shows `deploymentVersion: cert-ed8b5520b7df` (v1) with `versionTransition → cert-dc249c4931c4` (v2) *in progress*. So the assertion is read mid-transition: the new execution exists but its first workflow task on v2 has not completed. The phase 1 review reported 108/109 with this test passing (same dev-server binary, `temporal-sdk-typescript-1.24.0.exe` cached 22 Sep). Nothing in this commit's diff touches the hand-over path, so I do not attribute it to the diff; but the commit message's implied "one todo" is not what the branch does on this machine, and the acquisition brief should not claim a green suite. The test should wait for `versionTransition` to be absent (or for the first WFT of the new run) before asserting.

### Minor

**m1. The byte-identical claim is true and mechanically checked, but the manifest's "what changed" table is incomplete.**
`upstream.json`, `check.mjs:41`, `README.md:13-20`, `NOTICE.md`.
`activities.ts` matches byte for byte and is loaded by Node 24 type stripping; `orders.mjs:8-14` calls `createExpense(id)` / `payment(id)` with upstream's signatures. Two honest caveats the README should carry: the activities *registered with Temporal* are `orders.mjs`'s, so the activity input in history is `[{ id }]` where upstream's was `[id]` (same type names, different payloads); and `package.json` (deps copied from upstream, scripts rewritten) and `README.md` are derived from upstream files but are not in `upstream.json`, so `check.mjs` cannot notice them drifting. Upstream also has `tsconfig.json`, `.eslintrc.js`, `.nvmrc` etc. that have no port counterpart; `SOURCE.md` says only needed files are pinned, which is fine, but the manifest should be able to say "absent in the port, by design" so the table is the whole story. The pin also carries `saga/`, which nothing in this commit uses.

**m2. The README cites a reference-manual section that does not exist.**
`README.md:80` ("reference manual §3.9"). The manual's §3 ends at 3.7; external mode is `externalMode` in §1.1 and the report Update in §4/§6.

**m3. Three before/after sentences overstate the difference from upstream.**
`README.md:24-28, 49-51`.
- "a client bug that sends it twice, or a replay, is the workflow's problem": upstream's handler is `status = APPROVED` (`workflows.ts:22-24`), idempotent by construction; `payment` runs once either way. The port's contribution is that this is *proved*, not that upstream got it wrong.
- "a second start attaches to the first run instead of paying twice": upstream uses `workflowId: expenseId` too, so a second start *while running* fails with already-started, no double payment. The real difference is after completion (upstream would start a fresh run and pay again; the port's `startGoverned` returns `complete` and uses `REJECT_DUPLICATE`, `client.mjs:66-81`). That difference lives in the client helper, not in the certified machine, and holds only for callers that use `startGoverned`.
- "is refused before it enters history": true for the Update (validator); the Signal form of `polyflow.propose` is journaled and does enter history as a signal event.
- Also `machine.cjs:52-53`: "an approval that arrives after the window closed ... is a reject": at run time it is `rejected: terminal` from the host (`governed-workflow.mjs:417`) or `order ... is not open` (`:345`); the acceptor's `nothing-awaiting-approval` is reachable only in admission's exploration.

**m4. `polyflow admit` crashes instead of refusing when a candidate machine has a strict-profile defect.**
`platform/packages/cli/src/admit.mjs:143` → `polygraph/polyrun/src/check-effects.mjs:195`.
My first mutation left `reason` neither assigned nor `unchanged` in an acceptor; `admit()` threw `SamFrameError: next-state frame incomplete` out of the CLI with a stack trace rather than `ok: false` with a named problem. The manual's contract is "exit 1: the thing checked is not ok"; a CI job sees an unhandled exception instead. Catch and report.

**m5. Scenario (f) depends on a ~3 s window and on port 3000 staying free.**
`sample-expense.test.mjs:145-161`, `governed-workflow.mjs:54-63`.
With the server down, `createExpense` attempts at ~0, 1 and 3 s (`baseMs: 1000`, coefficient 2, `maxAttempts: 3`), then `CREATE_FAILED` makes the run terminal. `until` (line 152) polls up to 10 s; if the poll or the Update lands after exhaustion, the refusal reads `order ... is not open` (assertion at 154 fails) and the `STOP` at 155 throws `rejected: terminal`. It passes today because the first poll finds the order in tens of milliseconds. Use a copy of the machine whose `createExpense` retry is effectively unbounded for this worker, or park the `payment` order instead by having the test server hold `/action`.

**m6. Port 3000 is hardcoded, so the whole file fails in `before` if anything else listens there.**
`sample-expense.test.mjs:35`, `src/activities.ts:4,8` (upstream's URL, unavoidable while byte-identical). Say so in the file header and fail with a clear message; (f) also closes and reopens 3000 mid-suite, a second window for a collision.

**m7. Windows file URLs are hand-built.**
`sample-expense.test.mjs:28-29`, `server.mjs:86`. `file:///${SAMPLE.replace(/\\/g, '/')}` works because `fileURLToPath` output is absolute with a drive letter, but `pathToFileURL(join(SAMPLE, 'src/server.mjs')).href` is the supported form and percent-encodes correctly; the `server.mjs` main-module check compares `import.meta.url` to a hand-built URL and is false for any path `new URL` encodes differently (a `%` or `#` in a parent directory), so `npm run server` would silently not listen.

**m8. `fileSink('./ledger')` is relative to the cwd and `ledger/` is not ignored.**
`src/worker.mjs:20`, `.gitignore:24`. `npm run start` from the sample directory leaves an untracked `ledger/` beside the source. Resolve it from `import.meta.url` and add it to `.gitignore` next to the certificate rule.

**m9. Scenario (i) tests the plugin constructor, not "refused at worker start".**
`sample-expense.test.mjs:194-202`, `README.md:54-55`. It is a valid check of `certificates.mjs`'s digest comparison and is worth keeping as the sample's demonstration, but it is generic (any byte of any file) and does not start a worker; the README's sentence is accurate because the plugin is constructed before `Worker.create`, so no change needed beyond saying "at plugin construction".

**m10. No scenario exercises `CREATE_FAILED`, `PAY_FAILED`, a late approval after the window, or a duplicate approval.**
The README lists "a late approval after the window closed, a duplicate payment result" as the point of `stale-completions-reject` (`contract.json:37-42`). (d) covers timeout; nothing then proposes `APPROVE` and asserts the refusal, and nothing proposes `APPROVE` twice. Both are two lines each.

**m11. `check.mjs`'s header now describes `root` as a directory, and the Python manifest's `root: "."` prints as `samples-python@4e2f01e/.`.**
`check.mjs:5-8, 41-42`. Cosmetic; either give the Python pin a real root or print without the `/.`.

## Admission mutations (all in throw-away copies, deleted)

| Mutation | Expected | Result |
|---|---|---|
| baseline | admitted | admitted, 9 paths / 12 states, 9 guarantees |
| A. `APPROVAL_TIMEOUT` acceptor → `paying` | refused | refused: `no-payment-without-prior-approve`, `no-payment-after-reject-or-timeout`, state invariant `a-paid-expense-has-no-failure-reason` |
| B. mapper also emits `payment` on entering `pending_approval` | refused | refused: four effect invariants named, counterexample `START, CREATED, STOP` |
| C. `APPROVE` accepted again from `completed` (re-pay loop; `completed` non-terminal) | refused | refused: polygraph's own `cycle-edge-emits`, `stop-from-every-state`, `every-wait-has-an-exit` |
| D. no timer armed with the human order | refused | refused: `waits-on-people-arm-timers` |
| E. `START` → `pending_approval`, `createExpense` and `request_approval` emitted in the same step | refused | refused: `create-before-anything-else` (strict `c.step < e.step`, so co-emission does not count as "before"), `every-wait-has-an-exit` |
| F. `rejected` non-terminal, `APPROVE` accepted from `rejected` | refused | refused: `no-payment-after-reject-or-timeout` (the only effect invariant that catches it: `APPROVE` *is* before `payment`, so `no-payment-without-prior-approve` holds) |
| G. F plus dropping `no-payment-without-prior-approve` | refused | refused (same as F) |
| H. `STOP` accepted from `paying` | should be refused | **admitted** (M6) |
| I. `REJECT` with `{}`, with an off-domain reason, `APPROVE` with extra data, stepped through the host directly | run-time behaviour | all accepted: `reason` defaults to `'rejected'`; any string is accepted; the domain in `contract.json` bounds exploration only |

So `no-payment-after-reject-or-timeout` is not vacuous, contrary to what the terminal states suggest at first read: it is the only invariant that guards against a later edit making `rejected` or `timed_out` non-terminal. `create-before-anything-else` is right to demand a strictly earlier step. The exploration is small (9 paths) because the machine is small; "over every path the contract's domain allows" is true and modest.

## What is right

- **The byte-identical claim is honest and mechanical.** `activities.ts` is upstream's, `check.mjs` refuses drift in both directions, `NOTICE.md` names the MIT origin and the commit, and the adapters in `orders.mjs` keep upstream's call signatures. No build step: Node 24 strips the types.
- **The machine is a faithful rewrite of `workflows.ts`.** `CREATED → pending_approval`, approve → `paying` → `completed`, reject → `rejected`, window → `timed_out`, 10 s default, `payment` emitted only on entering `paying`, and the sample's "return `{ status }` without paying" is the terminal `rejected`/`timed_out` with nothing emitted; the server's `CREATED → COMPLETED` transition is the same as upstream's. `STOP` is an addition beyond upstream and is declared as such; `failed` covers the two activity failures upstream would have surfaced as a failed workflow.
- **The `outOfBand` change is narrow and correct.** External orders (`o.external`) and role orders still pass; `polyflow.report` already refused non-external orders (`:530`); the gateway runs in external mode; Jev's `polyflow.observe` orders are worker-performed with no role and are now, rightly, not completable by hand. The full suite shows no other regression; (f) covers the new refusal.
- **Double application is prevented.** `propose` marks the order `reported`, cancels its scope, and steps with `actionId = ${orderId}:done`, the same id the worker completion would use (`:369-375`); a second `APPROVE` is refused as `not open`; the timer and a proposal are serialised by the synchronous `step`. `startGoverned` uses `USE_EXISTING` + `REJECT_DUPLICATE`, so the "attach" claim holds at Temporal's level, not by a describe-then-start race.
- **The tests assert what they say**, including history-level checks (`scheduled(history)` for `createExpense, request_approval, payment` and for the absence of `payment`; `activityTaskCancelRequested` in (h)), the server's own state after each outcome, and both admission directions ((a) and (b), with the refusal named).
- The certificate is `.gitignore`d, the trust-store path for production is documented, the effect invariants are readable sentences, and mutation E shows the invariant author thought about same-step co-emission.

## Response (same session)

| Finding | Action |
|---|---|
| B1 a worker restart rejects the expense | **Fixed.** `request_approval` is now an order that stays open across restarts: `retry.maxAttempts: 1000`, `timeoutMs: 3600000` (the parked activity is re-scheduled; the run calls it off when the window closes or a person answers). Only when the request itself cannot be kept up does the run end `rejected` with reason `approver-unreachable`. The README says so, and states the rule that `timeoutMs` must exceed the window (M2). The deeper fix, a person's order that parks in the run and not on a worker slot (also M3), is a host change carried to the close-out: it changes how every `performer: human` order in worker mode behaves. |
| M1 who approved is not in the record | **Fixed.** `GovernedWorkflow.propose` now records the actor on the journal row (`by: { id, verified, roles }`) and appends a `proposal` event to the ledger (`source: 'human'` for a role-addressed order, `principal`, `orderId`, `dataDigest`) through the governor registry. Scenario (c) asserts both. Without `principals` the actor is recorded as `verified: false`, which the README now says plainly. |
| M2 `timeoutMs` caps the window silently | **Fixed** for the sample (1 h) and documented. An admission check that `retry.timeoutMs` of a human order exceeds the timer the same step arms is a small kernel addition; carried to the close-out. |
| M3 one activity slot per pending approval | Documented (README, "The parked activity"); the fix is the host change under B1. |
| M4 an infrastructure failure recorded as a rejection | **Fixed.** `onFailure` and `onExhausted` both give `approver-unreachable`; a person's rejection is only ever the `REJECT` a person proposes. |
| M5 axios/express advisories | **Fixed.** `axios@^1.7.9`, `express@^4.21.2`; `npm audit --omit=dev` finds 0 vulnerabilities; `activities.ts` unchanged; the licence audit has a row for the sample ports. |
| M6 `unstoppable` is an exemption, not a check | **Fixed** in the kernel: admission now runs `unstoppable-states-refuse-stop` (a state declared unstoppable must reject the stop action, observably); the mutation "STOP accepted from paying" is refused. Kernel suite 82/82. |
| M7 `versioning.test.mjs:118` red | Not reproduced: three full-suite runs in this session pass it (118/118 with the DST1-R todo), and the same scenario runs again in `sample-saga.test.mjs` (h). The `describe` mid-`versionTransition` read the reviewer saw is a real race in the *test's* assertion order; noted for the close-out, not changed here. |
| m1 manifest incomplete | **Fixed.** `upstream.json` gains `notPorted` (upstream files the port derives nothing from), which `check.mjs` verifies exist in the pinned copy. |
| m2 nonexistent §3.9 | **Fixed** (§4 and §6). |
| m3 three overstated sentences | **Fixed:** the "anyone can signal" contrast is replaced by "the signal names nobody"; the duplicate-start sentence says upstream refuses with an error; "refused before it enters history" is scoped to validation of the Update. |
| m4 `admit` crashes on a strict-profile defect | Open (kernel/CLI: catch `SamFrameError` and refuse with the frame). Carried. |
| m5, m6 the 3 s window and port 3000 | Accepted for the sample's test; the port is the sample's own. |
| m7 hand-built `file://` URLs | Accepted; `pathToFileURL` would be cleaner, noted. |
| m8 `./ledger` relative and unignored | **Fixed** (`.gitignore`: `platform/examples/temporal_samples/*/ledger/`). |
| m9 scenario (i) tests the constructor | Accepted: the worker's refusal *is* the plugin constructor, which `Worker.create` runs. |
| m10 no late/duplicate approval, CREATE_FAILED, PAY_FAILED scenarios | Open; the late-approval and duplicate cases are covered at the machine level by admission (`stale-completions-reject`, mutation F in this review), not at run time. Carried. |
| m11 `check.mjs` cosmetics | **Fixed** (`.` root prints without a slash). |
