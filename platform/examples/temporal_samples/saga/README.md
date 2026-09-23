# Temporal's `saga`, as a certified machine with a v2 through the gate

The official sample ([temporalio/samples-typescript `saga`](https://github.com/temporalio/samples-typescript/tree/main/saga),
pinned at `8907f29` under [`../../upstream/`](../../upstream/)) opens an account in
four steps (`createAccount`, `addAddress`, `addClient`, `addBankAccount`) and,
when one fails, runs the compensations of the steps that succeeded, last first,
swallowing any error a compensation raises. Its demo always fails at
`addBankAccount`, so what it shows is the compensating path.

Here that control flow is a SAM machine ([`machine/`](machine/)) that `polyflow
admit` certifies, and a second version ([`machine-v2/`](machine-v2/)) adds a
KYC check after the bank account, with its own compensation. What changed, and
what did not, is declared in [`upstream.json`](upstream.json) and checked by
`node platform/examples/upstream/check.mjs`:

| File | Status |
|---|---|
| `src/activities.ts`, `src/clients/index.ts`, `src/types/*.ts` — the seven activities, the four bounded-context clients, the commands | **byte-identical**, loaded as is by `src/loader.mjs`: Node's own TypeScript transform (`stripTypeScriptTypes`, transform mode, for the sample's `import X = …`), ts-node's extensionless imports resolved, and a binding synthesised for each erased `export interface`/`type` so type-only imports link. No build step; nothing in the sample's files is edited |
| `src/workflows.mjs` | the sample's `workflows.ts` *is* the control flow; it is now `machine/` and this file re-exports the governed host |
| `src/worker.mjs` | the plugin line; with trust, Worker Versioning with the certificate's build id |
| `src/client.mjs` | `startGoverned` with the sample's `OpenAccount` command as input; `--fail-at` reproduces the sample's injected failure |
| `machine/`, `machine-v2/` | new: the machine, its contract, effects, manifest, invariants, descriptor; v2 adds `migrate.cjs` |

## What the sample could not say, and the certificate does

Upstream, the compensation discipline is a `try`, an array `unshift`ed after
each success, and a `for` over it in the `catch`. Whether a compensation can
ever run for a step that did not succeed, or a forward step after compensating
began, is something a reviewer reads. The port makes them sentences admission
proves over every path the contract's domain allows:

```
guarantees: compensation-only-for-a-step-that-succeeded, every-succeeded-step-is-compensated-first,
  no-completion-without-its-order, no-forward-step-after-compensating-began, compensations-are-lifo,
  each-step-at-most-once, forward-steps-in-order, failed-only-when-nothing-to-compensate, ...
```

Route a client failure to the wrong compensation (`removeClient` for a client
that was never added), skip a compensation on the way back (a bank failure
that clears the address but never removes the client), or accept a completion
the run never ordered (`BANK_ADDED` from `adding_client`, opening the account
with no bank step): admission **refuses** each, by name. The test does all
three; the phase 3 review found the second and third admitted before those
two guarantees existed, which is what a review is for.

Three things changed on purpose:

- upstream swallows a compensation's error and moves on. Here a compensation
  retries (manifest), and if it fails for good the run ends
  `compensation_failed` naming the step and the reason, instead of
  `compensated` with a lie in it;
- upstream fails the workflow after compensating. Here `compensated` is a
  result, with `failedStep` and `reason`, not a fault;
- a person can call the saga off. `STOP` ends a run that has nothing to undo
  (before, or during, the two steps that register no compensation upstream
  either); past that, `CANCEL` compensates what succeeded, last first, and the
  run ends `compensated` with reason `cancelled`. The states in which `STOP`
  is refused are declared `unstoppable` with that reason, and admission checks
  that they do refuse it.

## v2 without `patched()`

Temporal's answer to changing a workflow with runs in flight is
`patched('my-change')`: both branches live in the code until every old run
has drained, four worker stages, and no proof that the new branch is safe for
the runs that will take it. Polyflow's answer is to version the *machine* and
move runs by *state*:

```
npx polyflow admit ./machine-v2 --key ci.key.json              # certify v2
npx polyflow vet --old ./machine --new ./machine-v2 --fleet fleet.json --trust trust.json
```

`vet` asks polyvers, once per distinct live state, whether v2 can take it:
migration valid and pure, every stimulus the old version can still deliver
accepted or rejected by name, invariants holding, the model checked from the
migrated states. Every v1 state comes back `migrate`; none is pinned. (What
makes it a migration rather than an `auto-upgrade` is the contract: polyvers
reads the `phase` type's prose, and v2 widens the enum. The migration is the
identity; a v2 that left the prose alone would auto-upgrade with the same
behaviour.) A v3 that *removes* the address step is pinned for every run: the
removed actions fail the vocabulary gate (deprecate, don't delete), and the
two runs parked in the removed step also hold orders v3 cannot complete. The
gate refuses to promote it.

Then, with Worker Versioning, `PolyflowGateWorkflow` runs `vet` over the live
fleet, tells each run that moves, and when v2 is the current version wakes
them: each continues as new onto v2 with its migrated state. `grep patched
src/` finds nothing.

Be precise about what that is and is not. `patched()` keeps an old run on its
*old* behaviour until it drains; here a run that started under v1 gets v2's
behaviour: a run parked in `adding_bank` re-issues its bank step on v2 and is
ordered the KYC check next. That is a **behavioural migration** the operator
accepts on vet's report (every v1 state, each stimulus, the invariants), not an
equivalence. Two rules make it safe:

- a step in flight finishes where it started. The hand-over calls open orders
  off and *waits*: an activity that heartbeats stops and is carried open, to be
  re-issued on v2 under the same order id and payload; one that does not runs
  to its end, its completion is stepped on v1, and a run that has moved past the
  state the gate vetted stays on v1 with `migration-stale` on the record, for
  the gate to re-vet. Nothing is done twice (tests h and i);
- the record is one chain. v1's part closes `continued-as-new`, v2's continues
  it; `polyflow verify` accepts the whole.

## Run it

```
temporal server start-dev
cd platform/examples/temporal_samples/saga
npm run start                        # v1 worker (development: allowUncertified)
npm run workflow                     # account opened
npm run workflow-compensate          # account not opened: compensated (addBankAccount: ...)
npm run start.v2                     # v2 worker; with POLYFLOW_TRUST set, both workers are versioned
```

The test is `packages/temporal/test/sample-saga.test.mjs` (ten scenarios:
admission of v1 and v2, three refused mutations, the happy and compensating
paths, the failed compensation, vet over a fleet, the pinned v3, the
end-to-end hand-over under Worker Versioning with the chain asserted, a step
in flight that finishes on v1, and a person's CANCEL).

## Two things to know

- **Failure injection.** The sample's `shouldThrow` field on a command is kept:
  `failAt` on the start input puts it on that step's command, so the sample's
  demo (`--fail-at addBankAccount`) runs unchanged through the sample's own
  clients. It is part of START's declared domain (admission explores it) and
  the acceptor refuses any other value; it is the sample's own test hook, not
  something a production start should carry.
- **What vet does not check.** polyvers' `matrix` and `product` gates judge
  parent/child machine rollouts; this host has no child machines (a mapper
  that spawns one poisons the run, and admission refuses it), so `vet` does not
  pin on them. Everything else polyvers defers still pins.
