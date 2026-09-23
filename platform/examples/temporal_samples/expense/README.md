# Temporal's `expense`, as a certified machine

The official sample ([temporalio/samples-typescript `expense`](https://github.com/temporalio/samples-typescript/tree/main/expense),
pinned at `8907f29` under [`../../upstream/`](../../upstream/)) is Temporal's
human-in-the-loop shape: an activity creates the expense, the workflow waits for
an `approve` or `reject` signal with a timeout, and if approved an activity pays.

Here that control flow is a SAM machine ([`machine/`](machine/)) that `polyflow
admit` certifies, and the worker hosts. What changed, and what did not, is
declared in [`upstream.json`](upstream.json) and checked by
`node platform/examples/upstream/check.mjs`:

| File | Status |
|---|---|
| `src/activities.ts` — `createExpense`, `payment` (POST to the expense server) | **byte-identical**, called through `src/orders.mjs` with their own signatures |
| `src/workflows.mjs` | the sample's `workflows.ts` *is* the control flow; it is now `machine/` and this file re-exports the governed host |
| `src/worker.mjs` | one plugin line: the machine, a sink, a signing key, trust |
| `src/server.mjs` | the sample's Express server in JavaScript (same endpoints, same transitions) |
| `src/clients/*.mjs` | `startGoverned`; the approval is a proposal against the open order, not a bare signal |
| `machine/` | new: the machine, its contract, effects, manifest, invariants and descriptor |

## What the sample could not say, and the certificate does

Upstream, "no payment without approval" is one `if` in `workflows.ts`, and
`approveSignal` names nobody: who approved is not in the record. The port turns
the property into sentences admission proves over every path the contract's
domain allows, and the certificate names:

```
guarantees: at-most-one-payment-per-path, no-payment-without-prior-approve,
  payment-implies-approval-was-requested, no-payment-after-reject-or-timeout,
  create-before-anything-else, exactly-one-create-when-started, ...
```

Delete the approval step from the machine (the test does: `CREATED` goes
straight to `paying`) and admission **refuses** it, naming
`no-payment-without-prior-approve`. That is the mutation a reviewer of the
sample would have to catch by reading.

At run time:

- the approval request is an **order addressed to the `human` role** with a
  10-second window armed by the machine (upstream's default). It is answered by
  `polyflow.propose { action: 'APPROVE' | 'REJECT', orderId, actor }`. The
  actor and the decision go into the journal row and into the signed ledger as
  a `proposal` event. Without the plugin's `principals` trust store the actor
  is a *claim* the caller makes (recorded as unverified); with it, a token
  signed for this one action. A caller without the role, or a proposal naming
  no order, is refused at validation, before it enters history;
- the workflow id is derived from the expense id (`polyflow/expense/<id>`), so
  a second start **attaches** to the first run and says so (upstream refuses a
  duplicate id with an error while the first runs);
- the request survives a worker restart: it is an order that stays open (the
  parked activity is re-scheduled, up to `retry.maxAttempts`), and only when
  the request itself cannot be kept up is the expense `rejected` with reason
  `approver-unreachable`, never `rejected` as if a person had said no. The
  manifest's `retry.timeoutMs` (1 h) must exceed the window the machine arms
  (10 s here): a window longer than the activity's timeout would end in
  `approver-unreachable` with a healthy approver;
- `STOP` ends the run from any state but `paying` (declared unstoppable: a
  payment in flight would not be unpaid), calling off the parked request;
- with `trust` on the worker (production), a machine whose bytes differ from
  its certificate is refused at worker start.

## Run it

```
temporal server start-dev
cd platform/examples/temporal_samples/expense
npm run server                # the sample's expense server on :3000
npm run start                 # the worker (development: allowUncertified)
npm run workflow-approve      # Done: { expenseState: 'completed', expenseId: 'my-business-id', reason: '' }
npm run workflow-timeout      # Done: { expenseState: 'timed_out', ... } after ~10 s
```

Production (G3): `npx polyflow admit ./machine --key ci.key.json` in CI writes
`machine/polyflow.certificate.json`; start the worker with
`POLYFLOW_TRUST=trust.json POLYFLOW_KEY=worker.key.json`.

The test is `packages/temporal/test/sample-expense.test.mjs` (nine scenarios,
including the mutation and the byte-changed machine).

## Two things to know

- **The parked activity.** In worker mode a person's order is an activity that
  parks, heartbeating, until the run calls it off; it is the request's presence
  on the worker, not the decision. It holds one activity slot per pending
  approval for the whole window, and its cancellation reaches it on the next
  heartbeat. With `externalMode`, orders are performed outside the worker
  through the MCP gateway instead (reference manual §4 and §6), and nothing is
  parked.
- **Node 24** loads the sample's `activities.ts` as is (type stripping); no
  build step. The sample's server and clients are TypeScript with an enum, so
  they are JavaScript here.
