# Review: P0 (foundations and spikes) and P1 (G0 Observe)

Adversarial review of `platform/packages/kernel`, `platform/packages/temporal`
and `platform/packages/cli` against the functional spec (FR-LED), the
technical spec (§1, §3.1–3.2, §4.5, §5.1–5.3, §15) and the implementation plan
(P0, P1 rows). The reviewer did not write the code and changed no production
code.

**Note on scope.** P2 work (guard, escalation, signal proposals, governed
workflows) was being added to the same files while this review ran. Line
numbers below are from the tree as it stood at the end of the review. Only the
P0/P1 surface was reviewed. The findings still apply to the current code.

## How to reproduce

The failing tests are kept next to the suites they break. Each one asserts the
behaviour the spec claims, so each one **fails today**. Because of that,
`npm test` in `kernel` and `temporal` now goes red until the findings are fixed
or the tests are removed.

| File | Tests | Needs server |
|---|---|---|
| `platform/packages/kernel/test/review-canonical.test.mjs` | K1, K1b | no |
| `platform/packages/kernel/test/review-machine-host.test.mjs` | H1 | no |
| `platform/packages/temporal/test/review-verify.test.mjs` | V1, V2, E1, E2, E3 | no |
| `platform/packages/temporal/test/review-temporal.test.mjs` | T1–T7 | yes (about 40 s) |
| `platform/packages/temporal/test/fixtures/review-{workflows,buggy,fixed}.mjs` | fixtures | – |

```
cd platform/packages/kernel   && node --no-warnings --test test/review-*.test.mjs
cd platform/packages/temporal && node --no-warnings --test --test-concurrency=1 test/review-*.test.mjs
```

The existing suites pass: kernel 46/46, cli 6/6 and temporal 8/8 at the time
of the first run.

---

## Summary

| # | Severity | Finding | Evidence |
|---|---|---|---|
| D1 | **blocker** | A workflow-*task* failure (e.g. a TypeError) schedules the close flush. After that, deploying the fix fails replay with a non-determinism error. | T2 |
| L1 | **blocker** | The chain is keyed by `firstExecutionRunId`, which is shared by workflow retries, cron runs and resets. A second execution restarts at seq 0 under the same key, so the chain forks, the sink reports conflicts and the ledger no longer verifies. | T1 |
| V1 | **blocker** | Dropping the tail of a ledger (events and the last head line) still verifies OK. This breaks the FR-LED.2 acceptance claim. | V1 |
| V2 | **blocker** | Anyone can append correctly chained events after the last signed head, and `verifyBundle`/`polyflow verify` return OK (exit 0). | V2 |
| E1 | major | The exporter signs a delta for **any** run named in the header. It never checks that the run is the activity's workflow, so the deployment key acts as a signing oracle. | E1 |
| E2 | major | The exporter signs the head the payload *claims*, not the head of the events it verified. | E2 |
| E3 | major | The exporter does not check continuity with the sink (§5.3). It accepts gaps and signs them without saying anything. | E3 |
| D2 | major | A close flush that fails changes the workflow's outcome, or replaces its real error. On the CAN path it turns continue-as-new into a failure. | T3 |
| L2 | major | Events carried on child-workflow start headers never reach the sink, so the sink's ledger has a gap. | T4 |
| L3 | major | Child-workflow observations are recorded at schedule time as `ok:true`, even when the child fails. | T4b |
| L4 | major | Events appended while the final flush is in flight (a late activity result, a signal) are never carried. The memo head then points past the exported ledger. | T5 |
| L5 | major | Idempotency keys and proposal/effect ids repeat across a Continue-as-New chain (and across retries). | T7 |
| P1 | major | A bundle loaded as `{ codePath }`, the standard production pattern, is refused. MARK does not bind the configuration. | T6 |
| G1 | major | `polyflow.flush` is recognised by activity **name**, so any activity with that name on any task queue bypasses recording (and, from P2, the guard). | code |
| K2 | major | Number and escaping rules are not pinned tightly enough for the promised Python port. `json.dumps` differs from JS on 1e-7, 1e16, 1.0, 1e-5 and non-ASCII. | repro |
| O1 | major | "Installed LAST" is not asserted. Spike P0.4 (ordering) has no test. | code |
| K1 | minor | Canonical JSON sorts keys before NFC-normalising them, so output can be unsorted or contain duplicate keys. | K1, K1b |
| H1 | minor | The machine host diverges from polyrun's `_dispatchInTxn` (`unhandled` vs `rejected`, and more). | H1 |
| M1 | minor | Headers have no size bound, and there is no batched-flush fallback (local-activity-heavy workflows). | code |
| M2 | minor | Retried local activities (with backoff) re-enter the interceptor, which records N effects for one local activity. | SDK code |
| M3 | minor | Ledger headers bypass the customer's payload converter. Raw error text is stored in plaintext history. | code |
| M4 | minor | `polyflow-ledger-head` is trusted from any start/CAN header. | code |
| M5 | minor | CLI `export` output can never pass `verify` (no heads), and it cannot rebuild a CAN chain. | code |
| M6 | minor | `readJsonl` silently drops *any* bad line. A torn line corrupts the next append. The file-sink cache is per process. | code |
| M7 | minor | Spec mismatches: memo only at close (FR-LED.2 says every task), no memo on CAN, `hist` never set, admission body incomplete, `source: 'workflow'` not in the enum. | code |
| M8 | minor | The generated-module directory is keyed without the plugin install path. Concurrent rewrites race. | code |
| M9 | minor | The P1.5 replay test covers one history shape only (no CAN, child, cancel or failure replay). | tests |
| N* | nit | Various: see the Nits section. | – |

---

## Blockers

### D1: A workflow-task failure becomes a non-determinism error after the fix is deployed

`temporal/src/workflow-interceptors.mjs:248-253`: the `execute` catch calls
`flush()` for **every** error except `ContinueAsNew`. In the TS SDK, only a
`TemporalFailure` (or a configured `failureExceptionTypes` error) fails the
*workflow*. Any other throw, such as a `TypeError` or `ReferenceError`, fails
the *workflow task* (`@temporalio/workflow/lib/internals.js:1061`). The
operator is expected to fix that kind of failure by deploying corrected code,
which then replays from history.

Under the plugin, the catch runs first and awaits a `polyflow.flush` activity:

1. The activation completes with a `ScheduleActivityTask(polyflow.flush)`
   command, and that command is committed.
2. The task fails later, at the next activation.
3. When the fixed code replays, it issues its real next command, and replay
   fails:

> `[TMPRL1100] Nondeterminism error: Activity type of scheduled event 'polyflow.flush' does not match activity type of activity command 'post'`

The test **T2** runs the same buggy workflow with and without the plugin. The
control replays the fix cleanly. The governed history fails with
`DeterminismViolationError`. This directly contradicts NFR-4 and FR-LED.6
("recovery — the plugin adds nothing that could diverge").

**Fix.** Only flush and upsert the memo when the workflow is really closing:

- `err instanceof TemporalFailure` (`ApplicationFailure`, `CancelledFailure`,
  `ActivityFailure`, `ChildWorkflowFailure`, …), or
- an error that matches the workflow's configured `failureExceptionTypes`.

Rethrow anything else untouched, synchronously, before any command is issued.
Add T2 to the suite.

### L1: Retries, cron and reset fork the chain under one key

`workflow-interceptors.mjs:79` keys the ledger by `info.firstExecutionRunId`
so that CAN runs share one chain. Temporal keeps `firstExecutionRunId` across
three other cases:

- **Workflow retries.** A new run starts with no `polyflow-ledger-head` header,
  so it opens a fresh chain at seq 0 (a new admission) under the **same** run
  key.
- **Cron runs.** Same effect.
- **Reset.** The new run re-derives identical events up to the reset point,
  then diverges.

**T1** runs a workflow with `retry: { maximumAttempts: 2 }` whose first
attempt fails:

- the sink reports conflicts at seq `[0,1,2,3,4]`
- the stored ledger (attempt 1's seq 0–4, attempt 2's seq 5+) no longer
  verifies

Two things make this worse:

- The sink is first-writer-wins, so the execution that really completed is the
  one that gets overwritten.
- Conflicts go only to `console.error` (`plugin.mjs:35`).

**Fix.** Key the chain by `(wf, firstExecutionRunId)` **and** an execution
discriminator that CAN carries forward but retry, cron and reset do not.

- Option A: key by `runId`, and have CAN write a `continuedFrom` link event
  carrying the previous run's head.
- Option B: keep the chain key, but make each new execution that arrives
  without a head header start a *new segment* whose genesis includes `runId`
  and `attempt`.

Both are cleaner than sharing seq space. Use the same fix for L5.

### V1 and V2: The tail of a ledger is neither protected nor authenticated

`temporal/src/verify.mjs:17-40` and `cli/src/main.mjs:61-68`. `verifyBundle`
passes when:

1. the chain from genesis is internally consistent, and
2. at least one head is trusted, signed and anchored.

Nothing binds the ledger's **end**:

- **V1.** Delete the last events and the heads that cover them. The remaining
  prefix is anchored by an earlier signed head, so it verifies OK. In the
  reproduction, dropping seq 4–8 (the `wire_money` effect) passes.
- **V2.** Anyone can extend the chain after the last signed head. Genesis is
  public and hashes are unkeyed, so correctly chained forged events are trivial
  to make. `verifyBundle` returns `ok: true` with `signedThrough: 8` and
  `chain.head.seq: 10`. The CLI prints a `note` line and then
  `OK — consistent and signed` with **exit 0**.

This contradicts FR-LED.2's acceptance ("altering, dropping or reordering any
exported event makes `polyflow verify` fail").

**Fix.**

- (a) Treat `signedThrough < chain.head.seq` as a failure, with at most an
  explicit `--allow-unsigned-tail` for in-progress runs.
- (b) Give the run a *terminal* event, for example
  `observation { closed: completed|failed|cancelled|continuedAsNew }` appended
  by the close path. Have `verify` require a signed head **on** the terminal
  event, or report the run as "open / possibly truncated".
- (c) Optionally, cross-check against the memo head fetched from Temporal
  (`polyflow verify --history`).

---

## Major

### E1: The exporter is a signing oracle for any run

`plugin.mjs:40-55`. The exporter:

- decodes whatever `polyflow-ledger` header the activity carries
- checks only that the delta chains internally
- signs `events[0].run`

It never compares that run to the activity's own `workflowExecution` (from the
activity `Context`). Any workflow code on the worker, or any interceptor that
runs earlier, can therefore do the following:

1. Compute a valid chain for **another** run id (genesis is public).
2. Attach it to one of its own activities.
3. Get the deployment key to sign it.

Because the sink is first-writer-wins, the forged ledger also takes over the
victim's seq slots. **E1** writes a "victim" ledger from an "attacker"
activity, and it verifies as signed.

**Fix.** In the exporter, require all of the following, and refuse to sign on
any mismatch:

- `events[*].run.wf === info.workflowExecution.workflowId`
- `run.ns === info.workflowNamespace`
- `run.run` is the execution's first run id (after L1, the execution's own
  key)

### E2: The signed head is the claimed head, not the verified head

`plugin.mjs:49` signs `head` from the payload. **E2** sends one event (seq 0)
with a claimed head of `{seq: 41, hash: 'sha256:abab…'}`. The deployment key
signs `seq 41`.

**Fix.** Sign `internal.head`, the output of `verifyChain`. Reject the payload
if the claimed head disagrees.

### E3: No continuity check with the sink

§5.3 says the exporter "verifies the chain continues from the last exported
head for that run". The code comment at `plugin.mjs:44-46` defers this to
`polyflow verify`. The sink appends any fresh seq regardless of `prev`
(`sink.mjs:60-67`). Gaps are accepted and signed without complaint (**E3**),
and so are the real-world gaps from L2.

**Fix.** Have `sink.write` return the sink's current head, and check that
`events[0].prev` equals it (or that `events[0].seq` is at most the sink's head
seq plus one). Report a gap through `onError`, not silently.

### D2: A flush failure changes the workflow's outcome

`workflow-interceptors.mjs:243-253`. If the flush activity fails, for example:

- during a rolling deploy onto a worker without the plugin
  ("activity not registered"), or
- because the flush task queue is misconfigured, or
- after 5 attempts,

then `await flush()` throws:

- **Success path:** the workflow's successful result is discarded and the
  workflow **fails** with the flush's `ActivityFailure` (**T3**).
- **Error path:** the flush error *replaces* the workflow's own failure.
- **CAN path** (`:195-201`): the continue-as-new becomes a workflow failure.

An observability plugin must never change the outcome.

**Fix.** Wrap the close flush in try/catch and swallow its failure (the
events are already in history for everything except the flush's own payload).
Alternatively, give the flush unlimited retries with a long schedule-to-close
timeout, and never let it replace `result` or `err`. Also consider making the
flush a local activity plus a marker, or carrying the tail on the memo
instead.

### L2: Child-workflow headers are never exported

`workflow-interceptors.mjs:192-194` carries the delta on
`startChildWorkflowExecution` headers. The only thing that reads headers on
the Node side is the **activity** inbound interceptor, so those events reach
history (`history.mjs:15` reads them) but never reach the sink. **T4**: the
sink's copy fails `verifyChain` with `missing event (next present is 4)`,
while the history copy verifies.

**Fix.** Either:

- do not carry on child starts (leave the events in the buffer for the next
  activity or the flush), or
- add a workflow-side exporter path (the child's `execute` could forward the
  parent's delta, but that couples the two runs; the first option is simpler).

### L3: Child-workflow observations are wrong

`startChildWorkflowExecution`'s `next()` resolves **immediately** to
`[startPromise, completePromise]` (`@temporalio/workflow/lib/workflow.js:411`).
So `governed()` appends the observation at schedule time:

- `ok: true`
- `resultDigest` is a digest of the SDK's promise tuple

It does this even when the child fails (**T4b**: the failed child is recorded
as `{"ok":true,"resultDigest":"sha256:b9fc…"}`).

**Fix.** For child workflows, return
`next(input).then(([started, completed]) => …)`, and append the observation
when `completed` settles. Record `started` failures (for example
`WorkflowExecutionAlreadyStarted`) as `ok: false`.

### L4: Events appended after the final drain are lost

The close flush drains the buffer when the flush activity is *scheduled*
(`:185`). While it is in flight, other coroutines can still append:

- a still-running activity resolving, whose `governed()` then appends its
  observation
- a signal (`handleSignal`, `:232-238`)
- an update

Nothing carries those events. The memo head (`:246`) is computed *after* the
flush, so it points at an event that exists nowhere.

**T5** (a detached activity that finishes while the flush is in flight) shows
the memo head at seq 8 while the history and sink ledger end at seq 7. The
same applies to the CAN path (`:198-200`): the `polyflow-ledger-head` handed
to the next run can include events that were never carried, so the next run's
chain is unverifiable from genesis.

**Fix.** After the flush resolves, loop: `while (l.pending() > 0) await
flush()`. Or better, freeze the ledger at close and carry the final head in
the memo only after a drain that appends nothing. On CAN, compute the head
header from the last *carried* event, and refuse to continue until the buffer
is empty.

### L5: Idempotency keys and ids repeat within one chain

`workflow-interceptors.mjs:141,163,166`:

- `pid`/`eid` come from a per-execution counter (`proposals`), which restarts
  at every CAN.
- `idempotencyKey` is `${wf}/${firstExecutionRunId}/${kind}/${input.seq}`, and
  `input.seq` also restarts per execution.

**T7** (3 CAN rounds) produces `…/activity/1` three times. A verdict's
`proposal: "p1"` is then ambiguous inside one chain, and the "idempotency" key
is not unique.

**Fix.** Include the execution's own `runId` in the key, or derive ids from
the ledger seq (for example `p${seq}`).

### P1: Pre-built bundles: `{ codePath }` refused, and MARK does not bind the configuration

`plugin.mjs:171` looks for MARK in `options.workflowBundle.code` only. The
documented production pattern is `workflowBundle: { codePath }` (bundle at
build time, load the file), and it is refused even when the bundle was built
with `plugin.bundlerOptions()` (**T6**).

In the other direction, MARK is a constant string. A bundle generated by
*any* PolyflowPlugin configuration is accepted. For example, an observe-level
bundle with a guard-level plugin passes, and the guard policy the operator
configured is then not what runs. This is a policy bypass from G1 onwards.

**Fix.**

- Read `codePath` when `code` is absent.
- Make the marker `Generated by PolyflowPlugin <digest(identity)>`, and
  require the digest to match `this` plugin's configuration.

### G1: The flush is identified by activity name

`workflow-interceptors.mjs:185`:
`if (OWN.has(input.activityType)) return next(...)`. Any workflow can call
`proxyActivities({ taskQueue: 'elsewhere' })['polyflow.flush'](...)`. The
activity runs arbitrary code on another queue with **no proposal, verdict or
effect**. At G0 that is a completeness hole. At G1 it is a guard bypass.

**Fix.** Mark the plugin's own call with a closure-private token, for example
a module-local `let flushing = false` set around the plugin's own call. Also
check `input.options.taskQueue` is unset or equal to the workflow's queue.
Record anything else named `polyflow.*` as an ordinary governed effect.

### K2: Cross-language canonical JSON is not pinned

§3.1 promises a Python implementation "pinned by the conformance corpus". The
corpus does not exist yet, and the rule "integers and finite numbers only" is
not enough to pin a byte encoding. Measured on this machine:

| value | JS `canonical` | Python `json.dumps` |
|---|---|---|
| `1e-7` | `1e-7` | `1e-07` |
| `1e16` | `10000000000000000` | `1e+16` |
| `1.0` | `1` | `1.0` |
| `1e-5` | `0.00001` | `1e-05` |
| `1.2345678901234568e20` | `123456789012345680000` | `1.2345678901234568e+20` |
| `"é"` | `"é"` | `"é"` (default `ensure_ascii`) |

Activity results and arguments are digested (`argsDigest`), so floats *will*
reach the chain.

The canonical.mjs header states the rule precisely: sort by UTF-16 code unit.
Python's default `sort_keys` orders by code point, so the port must be written
against that rule, not against Python's default. A conformance vector should
pin it, for example `{"\u{1F600}":…, "！":…}`: JS puts U+1F600 first, and
code-point order puts U+FF01 first.

**Fix.** Adopt RFC 8785 (JCS) number serialisation (ECMAScript
`Number.prototype.toString`) and escaping by name in §3.1. Add the conformance
vectors now: numbers at the exponent boundaries (1e-7, 1e-6, 1e20, 1e21),
astral-plane keys, U+2028/2029, lone surrogates and NFC-colliding keys (K1).

### O1: The "installed LAST" claim is not asserted

§5.1 and `plugin.mjs` claim the guard is ordered last "and at worker start it
asserts it is last and refuses otherwise". The code appends its module to
`workflowModules` (`:180`) and asserts nothing. A plugin listed *after*
`PolyflowPlugin` that appends its own interceptor module runs inside (after)
the guard and can rewrite the activity input the guard already decided.

Spike **P0.4** (plan row 0.5, "ordering") has no test: `spike.test.mjs` has
only P0.2. The composition order itself is right, since the last module is
innermost (`@temporalio/common/lib/interceptors.js:19-31`). The problem is
that nothing prevents a later plugin from moving the guard.

**Fix.**

- Add a test with a second plugin/interceptor that mutates `input.args` and
  check that the recorded `argsDigest` matches what was scheduled.
- Have `configureWorker` fail if Polyflow's module is not the last entry
  (checkable only in a later hook; alternatively document "list PolyflowPlugin
  last" and have the workflow-side interceptor compare `argsDigest` against
  the command actually emitted).

---

## Minor

### K1: Keys are sorted before NFC normalisation

`kernel/src/canonical.mjs:54-55` sorts **raw** keys and then emits
**normalised** keys.

- `canonical({'é':1, f:2})` gives `{"é":1,"f":2}`. That is not sorted
  (U+00E9 > `f`), so `isCanonical(canonical(x)) === false` (**K1**).
- `canonical({'é':1, 'é':2})` emits a duplicate member name:
  `{"é":2,"é":1}` (**K1b**).

A port that normalises first and sorts second produces different bytes.

**Fix.** Normalise, check for collisions (throw `CanonicalError` on
duplicates), then sort.

### H1: Machine-host parity with polyrun

Compared with `polygraph/polyrun/src/kernel.mjs` `_dispatchInTxn`:

- **Unhandled steps.** polyrun journals an action outside the surface, and a
  step no acceptor handled, as `step_kind: 'unhandled'` (`kernel.mjs:420-423`,
  `:451-453`). The host returns `'rejected'` (`machine-host.mjs:119,143`), so
  the FR-LED.4 window is not byte-compatible with `pr_journal` (**H1**).
- **Children and signals.** `spawnChild`/`signalChild` intents are valid in
  polyrun (FR-8) but **poison** in the host ("undeclared kind").
- **Load-time checks.** polyrun checks at load that the module
  `validate()`s strict-clean, that contract `stateKeys` match the module state
  (observable-is-total), and that `contract.actions` exist. The host does none
  of these, so a key mismatch silently loses state on every rehydrate.
- **Intent ids.** They are derived differently: polyrun uses
  `sha(instanceId|seq|kind|ordinal)`, the host uses
  `digest({runKey,seq,kind,ordinal})`. The same machine yields different ids
  under the two runtimes.
- **Mapper throws.** A mapper throw poisons in the host. In polyrun it is a
  plain error that rolls back the step without poisoning.
- **Null data.** `data ?? {}` turns `null` into `{}`. polyrun passes `null`
  through.

The header comment ("This is polyrun's `_dispatchInTxn` with the store taken
out … same semantics") overclaims.

**Fix.** Return `unhandled`. Port the load-time checks. Either support or
explicitly refuse children at load. Document the id derivation.

### M1: Unbounded headers

Events without a carrier accumulate: local activities never carry
(`:190`), and denials rely on the next carrier. The next activity header
carries all of them, with no bound. A workflow with thousands of local
activities followed by one activity can exceed the payload/header size limit
and fail its workflow task. The §5.2 fallback (a batched flush every N
events) is not implemented.

### M2: Local-activity backoff re-enters the interceptor

`scheduleLocalActivity` loops and re-invokes the outbound interceptor after
every `LocalActivityDoBackoff`
(`@temporalio/workflow/lib/workflow.js:307-336`). One logical local activity
is therefore recorded as N proposal/verdict/effect triples, each with a failed
observation. The result is deterministic, but it breaks "one effect per
activity".

### M3: Ledger headers bypass the payload converter

`toPayload` uses `defaultPayloadConverter` (`:23-24`). §5.2 says "encoded
through the workflow's payload converter". `failureText(err)` stores up to 200
characters of raw error text in plaintext history headers. Error messages
routinely carry URLs, tokens and PII, and FR-LED.5 redaction is not
implemented.

### M4: The resume head is trusted from the start header

`execute` trusts `polyflow-ledger-head` from any start or CAN header
(`:240`). A client can start a workflow with a forged head, so the chain
starts mid-sequence without an admission event. That makes the run
unverifiable: a denial of audit.

**Fix.** Accept the header only when `info.continuedFromExecutionRunId` is
set.

### M5: `polyflow export` output cannot verify

- `export` writes events without heads (`main.mjs:82`). `verify` refuses
  unsigned ledgers, so `export` followed by `verify` is always NOT OK.
- `export` takes one history. A CAN chain's later runs do not start at
  genesis.

The plan's acceptance "export-from-history equals the sink" holds for events
only. Document that, or let `verify --from-history` accept history-derived
events without signatures as a distinct verdict.

### M6: Sink robustness

- `readJsonl` (`sink.mjs:26`) drops *any* unparseable line, not only a torn
  final one. Corrupting the last line of an exported file therefore equals
  truncation, which V1 already lets pass.
- A torn final line with no newline is concatenated with the next append, and
  both are lost. The in-memory `known` map still believes they were written.
- `fileSink`'s `known` cache is per process. Two workers appending to one
  directory produce duplicate lines, and `verify` then fails with "out of
  order".

### M7: Spec and code mismatches

- FR-LED.2 says the head goes to the memo "on every workflow task". The code
  writes it only at close, and not on CAN.
- §3.2 `hist` (the Temporal event id) is never set.
- The admission body lacks `certificate/versionTuple/buildId`.
- `source: 'workflow'` is not in the §3.2 enum.
- The effect body uses `target` and `via` instead of `activityType`.

### M8: Generated-module directory

The directory is keyed by `digest({config, machines})` (`plugin.mjs:88-89`),
not by the plugin's install path. Two checkouts or versions of the plugin on
one machine with the same configuration overwrite each other's generated file,
so a worker may bundle the *other* checkout's interceptors. The concurrent
`writeFileSync` into a shared `%TEMP%` path can also be read half-written by
a bundler in another process.

**Fix.** Include `here` and the package version in the digest. Write to a
temp name and rename.

### M9: Replay coverage (P1.5)

`observe.test.mjs` "governed histories replay with zero non-determinism
errors" replays a single `agentLoop` history. There is no replay of CAN, child
workflows, cancellation, workflow failure, `Promise.all` or signals, which are
exactly the paths above where commands are added (the flush and the memo).

---

## Nits

- `err?.name === 'ContinueAsNew'` (`:249`). Prefer
  `err instanceof ContinueAsNew` (exported by `@temporalio/workflow`). A user
  error named `ContinueAsNew` would currently skip the close flush.
- `argsDigest` goes through `JSON.parse(JSON.stringify(...))`, which is lossy.
  `Map`, `Set` and class instances become `{}`, `Uint8Array` becomes an index
  object, `NaN` becomes `null`, and different arguments can share a digest.
- Pure-JS SHA-256 plus NFC over every activity result runs on every replay. A
  large result costs real CPU per replay (NFR-2).
- `verifyChain` does not check `v === 1` or that `at` is finite.
- CLI `verify` sorts lines by seq before checking, so reordering *lines* in the
  file is invisible. That is harmless, but the acceptance wording "reordering
  any exported event" should be read as reordering seq.
- Comments that overclaim:
  - "Worst case one extra Action per run" (§5.3): it is per *execution*, plus
    flush retries.
  - "a torn final append is not fatal": any line is skipped.
  - "It is installed LAST so the guard sees the final activity input": not
    enforced (O1).

---

## What held up

- Pure SHA-256 matches NIST and `node:crypto` across every padding length, and
  UTF-8 handles astral characters and lone surrogates correctly.
- Chain verification names the first bad link for edits, re-hashed edits,
  drops and swaps.
- By inspection, not by test: scheduling two activities in one activation
  (`Promise.all`) keeps a consistent carry order. Carry is synchronous before `next()`, so each
  header's delta is deterministic and non-overlapping.
- The `maxCachedWorkflows: 0` spikes are real (a local dev server, not mocks),
  and P0.3 header persistence is shown by the history-equals-sink test.
- By inspection, not by test: cancellation mid-activity is handled on the
  flush side: the observation is
  appended as `ok:false`, and the flush runs non-cancellable. The one caveat
  is the D2 outcome-replacement risk.

---

## Response (author, after the review)

Every blocker and every major finding is fixed. The reviewer's failing tests
now pass and stay in the suites as regression tests: `review-*.test.mjs`, with
`ordering.test.mjs` for O1. Suite totals after the fixes: kernel 51, cli 9,
temporal 41. All are green.

| # | Outcome | What changed |
|---|---|---|
| D1 | fixed | `execute` closes only on a `TemporalFailure`, a return or a Continue-as-New. Any other throw is rethrown before any command is issued. T2 passes. |
| L1 | fixed | A chain is keyed by the run that **started** it (its own `runId`). Only Continue-as-New hands it on, carrying `{run, seq, hash}` in a header. Retries, cron runs and resets start their own chain. The kernel comment says so. T1 passes. |
| V1, V2 | fixed | There is a new ledger kind, `closure` (completed \| failed \| cancelled \| continued-as-new), which every execution appends. `verifyBundle` requires a trusted signed head **on the last event** and a final closure. `--allow-open` accepts a run still in progress, and says so. |
| E1 | fixed | The exporter refuses and reports any delta whose run is not the activity's own workflow and namespace. It never signs one. |
| E2 | fixed | The exporter signs the head of the events it verified, never the head the payload claims. |
| E3 | fixed | Sinks expose `head(run)`. A delta that skips ahead, or does not point at the sink's head, is written (so the gap shows), reported through `onError`, and not signed. |
| D2 | fixed | Close flushes are wrapped. A failed flush never replaces the result or the error, and the missing closure is what `verify` then reports. T3 passes. |
| L2 | fixed | Only activities carry ledger deltas. Child-start headers no longer do. T4 passes. |
| L3 | fixed | A child's observation is appended when its completion promise settles, with the real outcome. T4b passes. |
| L4 | fixed | The closure and the trailing events go out together. The flush loops while events keep arriving, and the memo head is written only after a drain that left nothing pending. T5 passes. |
| L5 | fixed | Proposal and effect ids come from the ledger seq (`p<seq>`, `e<seq>`), so they are unique across a chain. The idempotency key uses the execution's own `runId`. T7 passes. |
| P1 | fixed | The bundle mark carries a digest of the configuration, the machines and the plugin's install path. `{ codePath }` bundles are read. A bundle built for a different configuration is refused. T6 now covers both directions. |
| G1 | fixed | The plugin's own flush is recognised by a closure-private flag set around its own call. Any other activity named `polyflow.flush` is governed like any other activity. |
| K2 | fixed | Canonical JSON is specified as RFC 8785 for number and string encoding. `platform/conformance/canonical.json` pins 11 vectors, including exponent boundaries, astral keys, U+2028/2029, NFC and a refused collision. The Python port must reproduce it byte for byte. |
| O1 | fixed | `runWorker` refuses to run a worker whose last workflow interceptor module is not Polyflow's. `ordering.test.mjs` proves both directions. |
| K1 | fixed | Keys are normalised first, collisions are refused, then keys are sorted. |
| H1 | fixed | The kernel now reports `unhandled` where polyrun does. It runs polyrun's load-time checks (validate, observable-is-total, contract actions exist) and derives intent ids as polyrun does. Null data passes through. Two differences remain and are documented in the module: parent/child intents poison with an explicit "not supported by this host yet", and a throwing mapper poisons, because a workflow has no transaction to roll back. |
| M3 | partly fixed | Failure text and approval notes are redacted (`kernel/redact.mjs`) before they are recorded. Ledger headers still use the default payload converter. **Deferred to P8:** encode through the customer's converter and codec. |
| M4 | fixed | A handed-over head is accepted only when `continuedFromExecutionRunId` is set. |
| M5 | fixed | `export` output is checked with `verify --unsigned`, which reports a different verdict: "CONSISTENT, UNSIGNED". |
| M6 | partly fixed | `verify` reads JSONL strictly, so any unparseable line is a finding. **Deferred:** the file sink's per-process cache. The file sink is documented as single-writer, and the multi-worker sink is the governance service (P8). |
| M7 | fixed in the spec | Technical spec §3.2 now lists `closure` and the `workflow` source, and describes the memo head as written at close (per-task writes would be billable). `hist` is dropped: the scheduled event id is not known when the event is appended. |
| M8 | fixed | The generated-module directory includes the plugin's install path, and files are written atomically (temp file, then rename). |
| M9 | fixed | New replay tests cover Continue-as-New (every execution), a failing child, a retried workflow and a signal. |
| M1, M2 | deferred | Header size and local-activity backoff re-entry. Both are deterministic, and neither affects correctness. They are tracked for P9 hardening, together with the batched-flush fallback. |
