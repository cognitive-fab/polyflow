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
| `src/activities.ts`, `src/clients/index.ts`, `src/types/*.ts` — the seven activities, the four bounded-context clients, the commands | **byte-identical**, loaded as is (`src/loader.mjs`: Node 24 type stripping plus ts-node's extensionless imports) |
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
guarantees: compensation-only-for-a-step-that-succeeded, no-forward-step-after-compensating-began,
  compensations-are-lifo, each-step-at-most-once, forward-steps-in-order, exactly-one-create-when-started, ...
```

Route a client failure to the wrong compensation (the test does: `removeClient`
for a client that was never added) and admission **refuses** the machine,
naming `compensation-only-for-a-step-that-succeeded`.

One thing changed on purpose: upstream swallows a compensation's error and
moves on. Here a compensation retries (manifest), and if it fails for good the
run ends `compensation_failed` naming the step and the reason, instead of
`compensated` with a lie in it.

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
migrated states. Every v1 state comes back `migrate` (the enum widened) or
`auto-upgrade`; none is pinned. A v3 that *removes* the address step is pinned
for the runs parked in it, and the gate refuses to promote it.

Then, with Worker Versioning (dev server ≥ 1.28), `PolyflowGateWorkflow` runs
`vet` over the live fleet, tells each run that moves, and when v2 is the
current version wakes them: each continues as new onto v2 with its migrated
state, exactly once. A run parked in `adding_bank` under v1 finishes its bank
step on v2 and is ordered the KYC check next. `grep patched src/` finds nothing.

## Run it

```
temporal server start-dev
cd platform/examples/temporal_samples/saga
npm run start                        # v1 worker (development: allowUncertified)
npm run workflow                     # account opened
npm run workflow-compensate          # account not opened: compensated (addBankAccount: ...)
npm run start.v2                     # v2 worker; with POLYFLOW_TRUST set, both workers are versioned
```

The test is `packages/temporal/test/sample-saga.test.mjs` (eight scenarios:
admission of v1 and v2, the refused mutation, the happy and compensating
paths, the failed compensation, vet over a fleet, the pinned v3, and the
end-to-end hand-over under Worker Versioning).

## Two things to know

- **Failure injection.** The sample's `shouldThrow` field on a command is kept:
  `failAt` on the start input puts it on that step's command, so the sample's
  demo (`--fail-at addBankAccount`) runs unchanged through the sample's own
  clients.
- **What vet does not check.** polyvers' `matrix` and `product` gates judge
  parent/child machine rollouts; this host has no child machines (a mapper
  that spawns one poisons the run, and admission refuses it), so `vet` does not
  pin on them. Everything else polyvers defers still pins.
