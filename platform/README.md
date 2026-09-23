# Polyflow for Temporal

**Temporal makes an agent's work survive a crash. Polyflow makes it checkably
allowed.**

It is a governance layer for agents that run on Temporal. It installs as a
worker plugin on the workflows a customer already has:

- rules are checked before a workflow may run;
- every effect is guarded while it runs;
- every decision is recorded so that someone else can verify it offline;
- each new version is gated against the runs already in flight.

> Experimental. Every check is a **consistency check, not a proof**, exhaustive
> only over the finite domains a contract declares. Design notes and evidence:
> [`docs/platform/`](../docs/platform/).

**Docs:** the [getting-started guide](../docs/platform/guide/01-getting-started.md)
and the [reference manual](../docs/platform/guide/02-reference-manual.md).

## Four levels, one at a time

| Level | What becomes deterministic | What the agent keeps | Change to a customer's code |
|---|---|---|---|
| **G0 Observe** | the record: a hash-chained, signed decision ledger carried on the activities the workflow already schedules | everything | add the plugin |
| **G1 Guard** | which effects may happen: sequence rules, budgets, rate limits, the lethal trifecta, approvals bound to one effect. A denial carries a witness the agent can re-plan from | its loop, its plan, its tool choice | + an admitted policy |
| **G2 Govern** | what may happen next: a certified SAM machine; the agent (or a worker, or a person) does each step | how each step is done | the workflow hosts a machine |
| **G3 Certify** | what may ship: `polyflow admit` certifies a machine; workers refuse anything else; `PolyflowGateWorkflow` vets a new version against the live fleet before the Worker Controller promotes it | writing the next version | + a CI step, + a ramp gate |

In addition:

- **Plans as proposals.** An agent may author a plan at run time. The plan is
  checked in every order it could execute, against the run's remaining
  authority, before any step runs.
- **Calibrated judgement.** Jev answers typed questions with probabilities.
  Declared bands turn each answer into a fact, or into no fact at all, and "no
  fact" goes to a person. A band is used only when its calibration meets the
  bar (sample size, precision, the same model).
- **Verified principals.** With a trust store, whoever approves, reports or
  claims presents a signed token. The workflow verifies it itself, so a name in
  a payload is not an identity.
- **Sealed headers.** Temporal's payload codecs skip headers. With a data key,
  the ledger a workflow carries is sealed before it reaches history.
- **Policy ramps.** A G1 policy change is vetted against the guard state of
  every run in flight before workers carrying it are promoted.

## Packages

| Package | What |
|---|---|
| `packages/kernel` | Pure, with no dependencies, and runs inside the workflow isolate. It covers canonical JSON (RFC 8785), SHA-256, the ledger, the policy and rule kernel, the SAM machine host, certificates, structural exploration, observation batteries and plan admission. |
| `packages/temporal` | `PolyflowPlugin` (TypeScript SDK). It provides the interceptors, `GovernedWorkflow`, `PolyflowGateWorkflow`, `proposePlan`, the Jev activity, sinks, offline `verifyBundle`, `vet` (polyvers), and OTel span attributes. |
| `packages/cli` | `polyflow verify \| export \| keygen \| policy \| admit \| vet` |
| `packages/gateway` | An MCP server offering polyflow's six unchanged work-order tools plus `workflow_claim`, over governed runs on a Temporal namespace |
| `packages/service` | The optional governance service: a sink with tamper alerts, verification, run reports, the evidence pack, metrics and a console |
| `packages/verify` | The verifier, the sinks and signed heads, rebuilding a ledger from a Temporal history: the Apache-2.0 half anyone may run (`polyflow verify` calls into it). |
| `python/polyflow_temporal` | The Python kernel port and the Python plugin (G0/G1). It is pinned byte for byte to TypeScript by [`conformance/`](conformance/). [`python/examples/openai_agents`](python/examples/openai_agents/) runs an unmodified OpenAI Agents SDK agent under G1, with MCP tools classified by name. |
| `python/polyflow_langgraph` | The second engine binding (plan P10), at G0/G1: `govern(tools, ...)` records and guards an unmodified LangGraph agent's tool calls with the same ledger and guard. It imports no `temporalio`. See [`06-second-engine-langgraph.md`](../docs/platform/research/06-second-engine-langgraph.md). |
| `examples/` | `customer-brief` (v1 and v2), `refund-triage` (Jev); [`temporal_samples/`](examples/temporal_samples/) rewrites Temporal's official `expense` and `saga` samples as certified machines (and [`python/examples/temporal_samples/`](python/examples/temporal_samples/) the `customer_service` agent at G1), with `upstream/` pinning the sources and `check.mjs` asserting which files stayed byte-identical |

## Install (TypeScript worker)

```js
import { PolyflowPlugin, fileSink } from '@cognitive-fab/polyflow-temporal';

const worker = await Worker.create({
  taskQueue: 'agents',
  workflowsPath: require.resolve('./workflows'),
  // List Polyflow last: its guard must see the final activity input.
  plugins: [otherPlugins, new PolyflowPlugin({ level: 'guard', policy, sink: fileSink('./ledger'), signingKey })],
});
```

Options worth knowing (see `PolyflowPlugin` in `packages/temporal/src/plugin.mjs`):

- `principals` and `audience` turn on verified principals. Mint tokens with `signPrincipal`.
- `headerKey` seals ledger headers. Keep `generatedDir` private to the worker, because the generated module holds the key.
- `externalMode` lets agents or people perform governed orders through the gateway.
- `memo: true` also writes the chain head to the memo. It costs one more billable Action per execution.

For the Python plugin, a policy's `routes` classify a generic tool activity by the
tool it carries: `{ "routes": { "Tickets-stateless-call-tool-v2": "0.tool_name" } }`.

## Tests

```bash
cd platform && npm install
(cd packages/kernel && npm test)                  # no server
(cd packages/cli && npm test)                     # admission, verify, vet
(cd packages/temporal && node scripts/test-each.mjs)   # downloads a Temporal dev server; includes DST and pass^k
(cd packages/gateway && npm test)
(cd packages/service && npm test)
(cd python && .venv/Scripts/python -m pytest -q)  # conformance + the Python plugin on a dev server
```

## What this does not do

- It does not replace Temporal, and it ships no durability of its own to
  Temporal customers. The standalone engine, polyrun, lives in polygraph.
- It does not make an agent correct. It makes the agent's effects checkable
  against rules somebody wrote, over a declared domain.
- Without a `principals` trust store, an approval records who the caller
  *claimed* to be (`verified: false`). With one, it records who they are.
- The S3 test is the re-fire mechanism, scripted. Replicating the
  FINDINGS-phase3 study with a real model is open work, and so is the pass^k
  harness's agent: it is a seeded stochastic script, not a model.

## Licence

Source-available, not open source: the plugin, gates, CLI, gateway, service and Python package are under the Business Source License 1.1 (non-production use is free; production use is a commercial licence at USD 1,000 per year per organisation; each version converts to Apache-2.0 four years after publication); the kernel and the verifier are Apache-2.0, so a record is checkable by anyone. [`LICENSING.md`](LICENSING.md) says which part is under which licence and why.
