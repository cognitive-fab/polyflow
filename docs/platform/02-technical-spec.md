# Polyflow for Temporal — technical specification

How the functional specification ([`01-functional-spec.md`](01-functional-spec.md))
is built. Every section names the requirements it serves. Where this document
and the code disagree, the document is changed first.

> Experimental. Every check described here is a **consistency check, not a
> proof**, exhaustive only over the finite domains a contract declares.

---

## 1. Principles that decide the architecture

1. **Inside the workflow, only pure things.** The guard, the SAM machine, the
   hash chain and the ledger buffer are pure functions of recorded history and
   pinned artefacts. They run inside workflow code, replay deterministically,
   and cost zero billable Actions. Everything with I/O — signing, exporting,
   calling Jev, talking to a human — runs in an activity, an activity
   interceptor, a client, or out of band. *(FR-GRD.8, NFR-4, NFR-13)*
2. **The history is the ledger's source; the ledger is its index.** Because
   every verdict is a pure function of recorded inputs and a pinned policy,
   any verdict can be re-derived from the Temporal history. The ledger does not
   have to be written synchronously to be complete; it has to be *verifiable*
   against the history. What cannot be re-derived — a denial that scheduled
   nothing — is written into the history on a carrier that already exists.
3. **GA seams only on the critical path.** *(NFR-14)*
4. **One kernel, two runtimes.** The pure kernel is the same code under Temporal
   and under polyrun; polyrun is the reference the Temporal binding is tested
   against.
5. **Nothing a model can name.** Workflow ids, actors, versions and approval
   bindings are derived or minted. *(doctrine 6)*

---

## 2. Components and repository layout

The platform lives in this repository under `platform/`, an npm workspace
separate from the published `@cognitive-fab/polyflow` package at the root
(which stays the single-participant MCP engine and is a dependency, not a
host).

```
platform/
  package.json                 private workspace root
  packages/
    kernel/                    @cognitive-fab/polyflow-kernel     pure, zero-dependency
      src/canonical.mjs          canonical JSON (sorted keys, no -0, no undefined)
      src/sha256.mjs             pure-JS SHA-256 (runs in the workflow isolate)
      src/ledger.mjs             event types, hash chain, window projection
      src/rules.mjs              the G1 rule kernel: policy -> guard state machine
      src/policy.mjs             policy parsing, validation, satisfiability
      src/machine-host.mjs       SAM v2 strict-profile step host (propose -> verdict, effects)
      src/certificate.mjs        certificate schema, canonical digest, verify (sig via injected fn)
      src/witness.mjs            witness construction for denials and rejects
    temporal/                  @cognitive-fab/polyflow-temporal   the Temporal plugin (TypeScript SDK)
      src/plugin.mjs             PolyflowPlugin (SimplePlugin): wires everything below
      src/workflow-interceptors.mjs   outbound guard + inbound update/signal hooks (workflow isolate)
      src/activity-interceptors.mjs   ledger exporter, signer (activity context, may do I/O)
      src/governed-workflow.mjs  the generic GovernedWorkflow (workflow isolate)
      src/activities.mjs         work-order activities, jev.observe, plan.admit, ledger.flush
      src/gate-workflow.mjs      PolyflowGateWorkflow for the Worker Controller
      src/client.mjs             start/attach with derived ids; Update-with-start helpers
      src/sink.mjs               ledger sinks: JSONL file, HTTP (governance service), stdout
    cli/                       @cognitive-fab/polyflow-cli        `polyflow` command
      admit | certify | verify | whatif | vet | export | report
    gateway/                   @cognitive-fab/polyflow-gateway    MCP server over a Temporal namespace
    service/                   @cognitive-fab/polyflow-service    optional governance service (Postgres)
  python/
    polyflow_temporal/         PyPI polyflow-temporal: native rule kernel + ledger + plugin
  conformance/                 shared JSON corpus: kernel inputs -> expected outputs, all languages
  examples/
    customer-brief/            G2 governed version of workflows/customer-brief
    guarded-agent/             G0/G1 on an unmodified agent-loop workflow
```

Dependencies: `kernel` depends on nothing. `temporal` depends on `kernel`,
`@temporalio/*` and, for G2/G3, `@cognitive-fab/sam-pattern` and
`@cognitive-fab/polygraph` (for `check-effects`, `polyvers` in activities and
the CLI — never inside workflow code). Licence: Apache-2.0 throughout *(NFR-10)*.

---

## 3. Data model

### 3.1 Canonical encoding and digests

All hashed or signed structures are encoded with **canonical JSON**: numbers
and strings encoded as RFC 8785 (JCS) encodes them (ECMAScript
`Number::toString`; only the mandatory string escapes, non-ASCII as UTF-8);
object keys NFC-normalised, collisions refused, then sorted by UTF-16 code
unit; no insignificant whitespace; finite numbers only, `-0` as `0`;
`undefined` fields dropped; string values NFC-normalised.
`digest(x) = "sha256:" + hex(sha256(utf8(canonical(x))))`. Every other
implementation reproduces `platform/conformance/canonical.json` byte for byte.

### 3.2 Decision events (FR-LED.1)

```jsonc
{
  "v": 1,
  "run": { "ns": "acme-prod", "wf": "<workflowId>", "run": "<runId>" },
  "seq": 17,                         // dense per chain, starts at 0 at the chain's admission
  "kind": "admission" | "proposal" | "verdict" | "effect" | "observation" | "closure",
  "at": 1790000000000,               // workflow time (workflow.now), never wall clock
  "body": { ... },                   // kind-specific, below
  "prev": "sha256:…",                // digest of event seq-1 (seq 0: digest of the run's admission)
  "hash": "sha256:…"                 // digest of this event with "hash" omitted
}
```

| kind | body |
|---|---|
| `admission` | `{ level, certificate?, policy, versionTuple, buildId }` |
| `proposal` | `{ source: workflow\|model\|tool\|human\|timer\|signal\|agent, principal?, action, dataDigest }` — its id is `p<seq>` |
| `verdict` | `{ proposal, outcome: accepted\|rejected\|allowed\|denied\|escalated, reason?, rules[], witness?, approval? }` |
| `effect` | `{ id: e<seq>, proposal, kind, class, via, activityType, argsDigest, idempotencyKey, approval? }` |
| `observation` | `{ effect, ok, resultDigest \| error (redacted) }` |
| `closure` | `{ outcome: completed\|failed\|cancelled\|continued-as-new }` — ends an execution's part of the chain; a verifier requires a final one |

**Chain identity.** A chain is keyed by the run that started it. A
Continue-as-New execution resumes it from a `{run, seq, hash}` header, accepted
only when the execution really is a continuation. A retry, a cron run or a
reset starts a chain of its own. Ids derive from the ledger seq, and
idempotency keys from the executing run's own id, so both are unique across a
chain (P0/P1 review L1, L5).

**The event id is not recorded.** The Temporal event id of the carrier is not
known when an event is appended; the carrier is recoverable from the history
(`polyflow export`).

**Codec (NFR-7).** Ledger headers are not payloads and do not pass through the
customer's payload codec on their own. Until plan step P2.6, headers carry only
digests, kinds, rule ids, principals as claimed, and redacted, truncated error
text; never argument or result values. The error text is the gap P2.6 closes.
From P2.6 the header body is encoded with the worker's payload codec.

**Policy is part of the build.** The policy is compiled into the worker's
bundle. Changing it is a redeploy and a version ramp, on purpose: a policy is
versioned, certified and gated like code (P4.6 gates the ramp).

**Fleet-gated versioning is a G2 feature.** The gate reads machine state, so
D5 covers `GovernedWorkflow` runs. At G1 the equivalent is the policy ramp
gate (P4.6), which vets a new policy against the guard states of runs in flight.

Payload bodies larger than 1 KiB are replaced by their digest; the customer's
codec and external storage hold the bytes *(FR-LED.5, NFR-7)*. Secrets are
redacted **before** digesting, with the same pattern set as
`src/decisions.mjs`, extended per tenant.

### 3.3 The window (FR-LED.4)

For G2 runs, every machine step is also emitted as the ecosystem window
`{instanceId, seq, action, data, pre, post, stepKind, rejectReason, actionId,
machineVersion}` — byte-compatible with `pr_journal` rows, so `polyrun audit`
and `polygraph` consume it unchanged.

### 3.4 Policy (FR-GRD.2, FR-GRD.5)

```jsonc
{
  "policy": "customer-comms",
  "version": 3,
  "effects": {                                   // activity type -> effect kind + class + labels
    "slack_send":   { "kind": "post",    "class": "irreversible", "labels": ["egress"] },
    "fetch_url":    { "kind": "fetch",   "class": "none", "labels": ["reads-untrusted"] },
    "read_crm":     { "kind": "read",    "class": "none", "labels": ["reads-private"] },
    "ask_approval": { "kind": "approval","class": "none" }
  },
  "unlabelled": "report" | "deny" | "escalate",  // default "report" (allow + record)
  "rules": [
    { "id": "no-post-without-approval",  "type": "requires-prior", "guards": "post", "prior": "approval", "outcome": "ok", "bind": "per-effect" },
    { "id": "at-most-one-post",          "type": "at-most", "guards": "post", "n": 1 },
    { "id": "no-post-after-cancel",      "type": "never-after", "guards": "post", "after": { "signal": "CANCEL" } },
    { "id": "trifecta",                  "type": "trifecta", "egress": "egress", "untrusted": "reads-untrusted", "private": "reads-private", "declassify": "approval", "outcome": "escalate" },
    { "id": "token-budget",              "type": "budget", "metric": "tokens", "max": 200000 },
    { "id": "tool-calls",                "type": "budget", "metric": "effects", "max": 400 },
    { "id": "rate",                      "type": "rate", "guards": "post", "n": 3, "perMs": 3600000 }
  ],
  "machines": [ "./policy-machines/refund.cjs" ],   // optional SAM policy machines (§4.4)
  "escalation": { "role": "approver", "budgetPerHour": 20 }
}
```

Rule types are closed: `requires-prior`, `at-most`, `never-after`,
`implies-prior`, `trifecta`, `budget`, `rate`, `machine`. **Every rule names the
effect kind it guards** in `guards` — the enforcement point never infers it
from the rule id (fixes research/03 §5.4). A rule with an unknown type refuses
the policy.

### 3.5 Certificate (FR-ADM.1)

```jsonc
{
  "v": 1,
  "subject": { "workflowType": "GovernedWorkflow", "machine": "customer-brief" },
  "artefacts": {                                  // digest of each file's bytes, LF-normalised
    "contract": "sha256:…", "machine": "sha256:…", "effects": "sha256:…",
    "manifest": "sha256:…", "effectInvariants": "sha256:…", "invariants": "sha256:…",
    "migrate": "sha256:…", "policy": "sha256:…", "descriptor": "sha256:…"
  },
  "guarantees": ["at-most-one-post-per-path", "no-post-without-prior-approval", "…"],
  "checks": [
    { "name": "check-effects", "pathsExplored": 5, "statesSeen": 10, "bounded": false, "violations": 0 },
    { "name": "structural", "items": ["waits-arm-timers", "stop-reachable", "effects-classified"], "violations": 0 }
  ],
  "domains": "sha256:…",                          // digest of the contract's dataDomain
  "boundAccepted": null | { "by": "principal", "note": "…" },
  "toolchain": { "polygraph": "8.3.0", "kernel": "0.1.0" },
  "buildId": "cert-3f2a9c",                       // = first 12 hex of the digest below; the Worker Deployment build id
  "issuedAt": "2026-09-22T…Z",
  "digest": "sha256:…",                           // digest of everything above
  "signatures": [ { "keyId": "ci-2026", "alg": "ed25519", "sig": "base64…" } ]
}
```

The certificate **is** the version *(FR-ADM.6)*: `buildId` is derived from its
digest and used as the Worker Deployment Version's build id. There is no second
version number.

---

## 4. The pure kernel (`packages/kernel`)

### 4.1 Guard state and evaluation (FR-GRD.1–.8)

The rule kernel compiles a policy into a **guard**: a deterministic reducer
over the run's effect history.

```
guard = compile(policy)
state0 = guard.init()
decide(state, candidate) -> { outcome: allow|deny|escalate, rules[], witness?, next? }
observe(state, event) -> state'        // proposals, effects, observations, signals
```

`state` is small and sealed: per effect kind, a count, the seq of the last
occurrence and of the last *successful* occurrence; label flags
(`untrusted`, `private`, `declassifiedAt`); budget meters; a bounded ring of
timestamps per rate rule; and the set of **unconsumed approvals** (§6.3). It
is canonical JSON, so it round-trips through Continue-as-New and a Query.

`decide` evaluates every rule whose `guards` matches the candidate's kind (and
every budget), in declaration order, and combines them: any `deny` → deny; else
any `escalate` → escalate; else allow. All matching rules are reported, not
only the first, so a witness is complete.

**Witness** *(FR-GRD.3)*: `{ rule, bindings: {kind, args digest, counters},
sequence: [the effect events that make the candidate a violation, or the
missing prior], allowedNow: [effect kinds that would be allowed from this state],
fix: "<one sentence>" }`. The `fix` sentence is generated from the rule type
("request `approval` and wait for it to succeed before `post`"), never by a
model.

**Replay safety** *(FR-GRD.8)*: `decide` and `observe` take workflow time as an
argument; they read no clock, no randomness, no environment. The kernel's own
test suite runs every function twice on the same inputs and compares
canonical bytes.

### 4.2 Satisfiability and policy admission (FR-GRD.10)

Before use, a policy is admitted: every rule type is known; every `guards`
names a declared effect kind; for `requires-prior` the prior kind is
declared; no rule set denies every sequence containing its guarded kind
(checked by a bounded search over sequences of declared kinds up to length
`2·|kinds|+1` — a rule that makes its guarded effect unreachable is refused
unless marked `"forbid": true`); every `machine` rule's SAM module passes
`polygraph` admission. The admitted policy's digest goes into the certificate
and into every `admission` event.

### 4.3 Machine host (FR-GOV.1–.4, FR-GOV.11)

`createHost(module, contract, mapper, manifest)` wraps a SAM v2 strict-profile
module:

```
host.init(snapshot?)                 -> state
host.step(state, action, data, id)   -> { stepKind: accepted|rejected, reason?, post, effects[], timers[] }
host.dryRun(state, action, data)     -> { stepKind, reason? }            // for Update validators
```

Each call rehydrates the module (`init()` + `setState(state)`), fires
`actions[action](data)`, classifies with `lastStep()`, reads `getState()`, and
runs the pure mapper on `(pre, action, data, post, stepKind)`. Any throw, any
effect kind not in the manifest, any frame violation is **poison** — the host
returns `{ poisoned: reason }` and the workflow quarantines (§5.4). The host
never lets a machine see the clock: time enters as action data.

### 4.4 SAM policy machines (FR-GRD.2 `machine` rules)

For stateful obligations the declarative rule types cannot express, a policy
may name a SAM machine whose actions are effect kinds and whose rejects are
denials. The guard steps the machine with each candidate as a dry run and
denies on reject, carrying the reject reason as the witness rule. This is the
polyaxion shape; polyaxion's kernel becomes the implementation of `machine`
rules when licensing allows (research/03 §7.11), and until then the kernel's
own host serves.

### 4.5 Ledger (FR-LED.1–.2)

```
ledger = openLedger({ run, admission })      // seq 0 = admission event
ledger.append(kind, body, at, hist?) -> event // computes prev/hash
ledger.head()                                  // { seq, hash }
ledger.drain() -> events since last drain      // what rides on the next carrier
```

The chain is pure and replays identically, so recomputing it on replay costs
CPU, never Actions, and produces the same hashes.

---

## 5. Temporal binding (`packages/temporal`)

### 5.1 Installation

```js
import { PolyflowPlugin } from '@cognitive-fab/polyflow-temporal';
const worker = await Worker.create({
  plugins: [new PolyflowPlugin({ level: 'guard', policy: './policy.json', sink: 'file:./ledger' })],
  workflowsPath: require.resolve('./workflows'),   // re-exports polyflow workflows (TS bundling rule)
  taskQueue: 'agents',
});
```

`PolyflowPlugin` (a `SimplePlugin`) contributes:
- workflow interceptor modules (the guard; §5.2), **ordered last** so it sees
  the final activity input after every other plugin's interceptors (research/04
  R2); at worker start it asserts it is last and refuses otherwise;
- activity interceptors (the exporter and signer; §5.3);
- activities (`polyflow.flush`, `polyflow.observe`, `polyflow.admitPlan`,
  work-order activities);
- `GovernedWorkflow` and `PolyflowGateWorkflow`;
- at `configure_worker`: loads and verifies certificates (§7.2) and fails the
  worker on any mismatch.

The policy and certificates are loaded **outside** the isolate, verified, and
passed into the workflow isolate as frozen data through the interceptor
factory's closure (bundled at worker build) — the isolate never reads files.

### 5.2 G0/G1: the outbound guard (FR-GRD.1, FR-LED.1)

`WorkflowOutboundCallsInterceptor.scheduleActivity(input, next)` (and
`scheduleLocalActivity`, `startChildWorkflowExecution`, `startNexusOperation`,
`signalWorkflow`):

1. Map `input.activityType` to an effect kind and class via the policy.
   Unmapped → `unlabelled` handling.
2. Append `proposal` (source `agent` when the call comes from a framework
   integration's tool activity, else `tool`) and compute `decide`.
3. **allow** → append `verdict(allowed)` and `effect`; attach the ledger delta
   and chain head to `input.headers['polyflow-ledger']` (encoded through the
   workflow's payload converter); call `next(input)`; on completion append
   `observation` and `observe` it into the guard state.
4. **deny** → append `verdict(denied, witness)`; throw
   `ApplicationFailure.nonRetryable(message, 'PolyflowDenied', witness)`.
   Nothing is scheduled, so the denial has no carrier yet: it stays in the
   buffer and rides on the **next** scheduled activity's headers, or on the
   close flush (§5.3). The agent loop receives the failure as a tool error
   whose message is the witness's `fix` sentence plus the rule id.
5. **escalate** → append `verdict(escalated)`; park on an approval
   (§6.3), then re-decide with the approval in state.

Cost: zero extra Actions for allow and deny. Escalation costs the Update that
answers it.

**Why headers.** An `ActivityTaskScheduled` event persists the activity's
headers. The ledger delta therefore becomes part of Temporal's own durable,
server-ordered history at no extra Action and no extra event. The activity-side
exporter (§5.3) ships it; if the exporter is down, the history still holds it
and `polyflow export` recovers it later. *Spike P0.3 confirms header
persistence and size behaviour in the TS SDK; the fallback is a batched
`polyflow.flush` local activity every N events.*

### 5.3 The exporter and the close flush (FR-LED.2–.3)

`ActivityInboundCallsInterceptor.execute` reads `polyflow-ledger` from the
activity's headers before running it, verifies the chain continues from the
last exported head for that run (idempotent: keyed by `(wf, run, seq)`), signs
the new head with the worker's deployment key (ed25519, `node:crypto`), and
writes the events to the configured sink. Activity code is not
replay-constrained, so this is where I/O belongs.

At workflow close — completion, failure, cancellation, Continue-as-New — the
inbound interceptor's `execute` wrapper schedules **one** `polyflow.flush`
activity **only if** the buffer is non-empty (typically: a trailing denial or
the final observation). It also upserts the memo key `polyflow.head` with the
final chain head. Worst case one extra Action per run.

### 5.4 G2: `GovernedWorkflow` (FR-GOV)

```
GovernedWorkflow({ machine, key, input, snapshot?, ledgerHead? })
```

- **Load.** `machine` names a certified machine bundled into the worker (the
  plugin builds a registry `certificateDigest -> {module, contract, mapper,
  manifest}` at bundle time; the isolate imports modules statically).
- **Start.** Run id derived by `deriveKey` in the *client* (`client.mjs`), used
  as the workflow id: `polyflow/<machine>/<key>`. Start and attach are one
  `signalWithStart` (or `executeUpdateWithStart` when the caller needs the
  first verdict) *(FR-GOV.5)*.
- **Loop.** State lives in a workflow variable. Proposals arrive from:
  - completions of work-order activities (the manifest's `onSuccess` /
    `onFailure` / `onExhausted` action),
  - `propose` **Update** (validator = `host.dryRun`; a rejected dry run throws,
    so the caller gets the reason synchronously; the client interceptor mirrors
    rejected Updates into the ledger sink because Temporal writes nothing for
    them — research/04 R4),
  - `propose` **Signal** (fire-and-forget; a reject is recorded as a
    `verdict(rejected)` event),
  - timers (workflow `sleep` raced against the run; firing proposes the timer's
    action, which a stale timer turns into an observable reject).
  Each proposal is stepped through `host.step`; effects become work orders
  (§5.5); timers are armed with `sleep`; the window and the decision events
  are appended to the ledger.
- **Queries.** `polyflow.state` → `{state, openOrders, timers, level,
  certificate, head}`; `polyflow.journal` → windows.
- **Visibility.** Search attributes set **at start** (free): `PolyflowLevel`,
  `PolyflowMachine`, `PolyflowCertificate`. Upserted **only on change of
  control state** (billed, rare): `PolyflowState`, `PolyflowPendingApproval`.
  `PolyflowLastVerdict='denied'` is upserted only on a denial *(FR-LED.7)*.
  Static summary / details carry the certificate badge and guarantees; current
  details show the state and open orders in Markdown.
- **Done.** The workflow returns when the host reports a terminal state; the
  result is `{ state, head }` *(FR-GOV.4)*.
- **Poison.** A poisoned step does not throw a workflow task failure (which
  Temporal would retry forever); it sets `PolyflowState=poisoned`, records the
  reason, and **blocks** on a `polyflow.release` Update from an operator
  (continue with a migrated snapshot) or a `STOP`.
- **Continue-as-New.** When `workflowInfo().historyLength` or history size
  passes 80% of the configured threshold, or updates received pass 1,500, the
  workflow continues as new with `{ machine, key, snapshot: state, ledgerHead,
  openOrders }` *(FR-GOV.6, research/04 R5)*. Open work-order activities are
  not carried; their completions after CaN arrive as proposals via the
  gateway (§8) because external completion is addressed by `(workflowId,
  orderId)`, not by task token, for orders that must survive CaN.

### 5.5 Work orders (FR-GOV.2, FR-AGT.3)

A work order is an activity `polyflow.order` with input `{ orderId, kind,
tool, target, args, why, role?, context }`. `orderId` is the effect intent id
`hash(runId, seq, index)`. Three performers:

| Performer | Implementation |
|---|---|
| **Worker-side handler** (the customer registered a handler for the kind) | the activity runs it; retry per manifest |
| **External agent over MCP** (polyflow's six tools) | the activity records its task token in the gateway's order table, heartbeats, and throws `CompleteAsyncError`; the gateway completes it when the agent calls `workflow_report` |
| **Human role** | same as external, routed to the inbox; heartbeat timeout disabled; the machine's timer bounds the wait (MA-11) |

The `context` field is the **state projection** for the step: the declared
fields of the state the order's kind reads, the invariant sentences that
mention the kind, and content-addressed references (not bodies) for
transcripts and documents *(FR-GOV.6)*.

### 5.6 The version gate (FR-VER)

`PolyflowGateWorkflow({ deployment, from: buildIdA, to: buildIdB })` is
registered with the Temporal Worker Controller as the deployment's gate
workflow. Activities:

1. `listFleet` — visibility query `PolyflowCertificate = '<A>' AND
   ExecutionStatus = 'Running'`, paged.
2. `snapshot` — Query `polyflow.state` on each (bounded concurrency), or read
   the Continue-as-New input for runs mid-CaN.
3. `vet` — run polyvers: lane classification of certificate A's artefacts vs
   B's, then each lane's gates over the snapshots (round-trip, pointwise
   invariants, vocabulary, migration validation, seeded model check). Also
   runs the Temporal **Replayer** over a sample of exported histories against
   B's worker bundle, which catches plugin-level NDEs polyvers cannot see.
4. `apply` — per run: auto-upgrade (set versioning override to AUTO_UPGRADE),
   pin (PINNED to A), or migrate (Update `polyflow.migrate` with the migrated
   snapshot, validated, then auto-upgrade). Each decision is appended to the
   run's ledger as an `admission` event.

The gate fails — the controller does not promote — if any lane gate fails, if
the corpus is empty and no synthetic corpus is declared *(FR-VER.5)*, or if the
Replayer reports an NDE. The workflow's result is the compat-report JSON; its
failure message is the report's first failing gate with its witness.

### 5.7 Principal and identity (FR-HUM.1)

Update and signal payloads never carry an identity the workflow trusts. The
principal comes from, in order: Temporal Principal Attribution in the
triggering event (when available and readable — open question P0.5); a signed
`polyflow-principal` header added by the client interceptor from the caller's
verified OIDC token (Tenuo's pattern) and checked in the inbound interceptor
against keys pinned in the policy; for polyrun, the gateway's minted actor id.
A principal is `{ type: human|agent|service, id, roles[], issuer, verified }`.

---

## 6. Humans, crews, approvals

### 6.1 Claims (FR-HUM.2)

For G2 runs, claims are Updates on the run itself: `polyflow.claim(orderId)`,
`polyflow.renew`, `polyflow.release`. The validator admits a claim if the order
is open, unclaimed or lapsed, and the principal holds the order's role; the
handler records `claimedBy` and `claimedUntil` and arms a lease timer. A
refused claim returns `{ claimed: false, holder }` as the Update's *result*
(accepted Update, negative answer) rather than a validator rejection, so the
refusal is in history and costs the same *(polycrew's "a refusal is an
answer")*. Only the holder's report completes the order.

For large human pools a separate broker workflow per role shards claims
(research/04 R5: 10 in-flight updates per workflow).

### 6.2 The inbox (FR-HUM.7)

The gateway (and later the service) maintains the order table
`orders(orderId, workflowId, runId, role, status, claimedBy, claimedUntil,
taskToken?, context)`. Console, chat integrations and the MCP tools read it;
every write goes through the workflow's Updates, so the workflow remains the
single source of truth and the table is a cache that can be rebuilt from
visibility queries.

### 6.3 Approvals bound to one action (FR-HUM.3)

An approval is recorded in the guard state as
`{ approvalId, effectKind, argsDigest, runId, principal, grantedAt,
consumed: false }`. `argsDigest` is the digest of the **canonical arguments
of the exact effect** the approval was requested for. `decide` for a guarded
effect with a `requires-prior` rule bound `per-effect` finds an unconsumed
approval with the same kind *and* the same `argsDigest`; allowing the effect
marks it consumed in the same step. So:

- a retry of the same activity by Temporal is not a new effect (same
  scheduled activity), so it needs nothing;
- a re-plan with a different amount has a different digest and needs a new
  approval;
- a crash after approval replays to the same consumed state.

### 6.4 Escalation budget (FR-HUM.5)

The service keeps per-reviewer counters; the guard's `escalate` outcome carries
a priority (consequence class). When a role's budget is exhausted, new
escalations queue, and the run waits on its timer, never on an unbounded
queue. The rate of escalations per role is exported as a metric and alerting
threshold.

### 6.5 Stop (FR-HUM.6)

The admission gate requires, for every non-terminal state, an accepted `STOP`
action leading to a declared safe terminal (checked by exploring `STOP` from
every reachable state). `polyflow.stop` is an Update available to any
principal holding the policy's `stop` role.

---

## 7. Admission and certificates

### 7.1 `polyflow admit` (FR-ADM.1–.5)

1. Load the workflow directory (the polyflow six-file layout plus
   `policy.json`, optional `migrate.cjs`).
2. `check-effects` over machine ∘ mapper with the effect invariants
   (polygraph's `checkEffects`, as `Library.certify` does today); refuse on
   violations or bounded exploration without `--accept-bound`.
3. Structural checks: every waiting state arms a timer (a state with an open
   order and no armed timer on some path is a violation); `STOP` reachable to a
   safe terminal from every non-terminal state; every effect kind has a class
   in the policy; every irreversible kind is guarded by at least one rule; every
   order role is declared.
4. Policy admission (§4.2).
5. Emit the certificate (§3.5); sign with the CI key (`--key`, or keyless via
   OIDC to the service in later phases).

### 7.2 Worker-side verification (FR-ADM.3)

At worker start the plugin, for each bundled machine: recomputes the artefact
digests from the files it is about to bundle (LF-normalised, which also fixes
the CRLF checkout issue in research/03 §7.13), compares them with the
certificate, verifies at least one signature from a key in the trust store,
and checks `buildId` equals the worker's deployment build id when Worker
Versioning is on. Any mismatch fails `Worker.create` with the file name and
the two digests.

---

## 8. The agent gateway (FR-AGT.3)

`packages/gateway` reuses the root package's `makeTools` and `serve` unchanged
by implementing the `Polyflow` surface against Temporal:

| `Polyflow` method | Temporal implementation |
|---|---|
| `catalog()` | certified machines from the certificate store |
| `begin(workflow, key, input)` | `deriveKey`, then `signalWithStart(GovernedWorkflow, id=polyflow/<wf>/<key>)` |
| `view(id)` | Query `polyflow.state` |
| `settle(id, …)` | poll `view` until the step lands (same contract as today) |
| `report(orderId, payload)` | `AsyncCompletionClient.complete/fail(taskToken)` from the order table, or `propose` Update for orders that crossed a CaN |
| `dispatch(id, action, data, actionId)` | `propose` Update with `updateId = actionId` (idempotent) |
| `journal(id)` | Query `polyflow.journal` |
| `runs()`, `timers()` | visibility query; `polyflow.state.timers` |

Because the six tools are unchanged, every host polyflow already installs into
(OpenWorker, Claude Code, Kiro, Hermes, dsh, NeMo) becomes a Temporal
participant with no host-side change. polycrew's `workflow_next` and
`workflow_claim` map to the claim Updates (§6.1).

---

## 9. Jev and plans

### 9.1 `observe` effects (FR-JEV)

A machine may emit `{ kind: 'observe', payload: { battery, projection } }`.
The manifest routes it to the `polyflow.observe` activity, which calls Jev
(`POST /v1/systemone`, `{state: projection, model, questions}`) and maps each
answer through its declared band: `noul` p ≥ assert → fact `true`; p ≤ refute
→ fact `false`; otherwise **no fact** (`unknown`). The activity's result —
`{facts, abstained[], raw digest}` — is the completion action's data. Jev is
never called on replay (the activity result is recorded), never inside an
acceptor (the admission gate refuses machine modules that `require` anything
but `@cognitive-fab/sam-pattern`), and the raw answers are stored by digest for
calibration tracking (FR-JEV.5). A Nexus `JudgeService` exposes the same
activity cross-namespace.

### 9.2 Plan admission (FR-PLAN)

`polyflow.admitPlan` activity input: a plan in one of two forms — a SAM module
source (polygen's output shape) or a **step list**
`[{ id, effect, args, after[], approval? }]` that the platform compiles to a
machine with a fixed template (a DAG executor whose states are "step i done").
The activity writes the plan to a temporary directory, runs `check-effects`
against the **parent's policy compiled to effect invariants** plus the
organisation's global invariants, with the plan's exploration budget, and
returns `{ admitted, certificate?, counterexample? }`. Admitted plans start as
child `GovernedWorkflow`s whose guard is the parent's remaining authority:
allowed kinds ⊆ parent's, budgets ≤ parent's remaining *(FR-PLAN.4)*. The
plan source is stored by digest in the ledger; the certificate is ephemeral
(not a worker build) and is verified by the child at start.

Security: a plan is **declarative JSON** (`parsePlan`): steps, kinds,
arguments and dependencies. No agent-written code is evaluated, at admission
or at run time. `node:vm` is not a security boundary and is not used. If
code-bearing plans are ever admitted, they run in QuickJS-Wasm (P0.6) with a
CPU budget and no host imports.

---

## 10. Python (FR-AGT.1, NFR-6)

Most agent integrations are Python. The strategy splits by level:

- **G0/G1 — native.** The kernel's ledger, canonical JSON, SHA-256 (stdlib
  `hashlib` is deterministic and safe in the sandbox as a passthrough) and the
  declarative rule kernel are small; they are ported to Python and pinned to
  the TypeScript implementation by the **conformance corpus**
  (`platform/conformance/*.json`: policy + event sequence → expected
  decisions, witnesses and chain hashes, byte for byte). The plugin uses
  `temporalio.plugin.SimplePlugin`, a `WorkflowOutboundInterceptor.start_activity`
  guard, sandbox passthrough for `polyflow_temporal.kernel`, and an activity
  inbound interceptor exporter. This covers the OpenAI Agents SDK integration:
  its tool and MCP calls are activities, so the guard sees each one.
- **G2 — hermetic evaluator.** SAM machines are JavaScript. In Python
  workflows they run in **QuickJS compiled to WebAssembly**, hosted by
  `wasmtime` as a sandbox passthrough: no clock, no I/O and no host imports
  exist inside the Wasm instance, so determinism holds by construction, and
  the same `.wasm` and the same machine source give the same bytes in Python,
  Go, Java and .NET. The conformance corpus includes machine steps. Fallback if
  the spike fails the latency budget (NFR-2): polygen code-generation of native
  Python acceptors, checked against the same corpus.

---

## 11. Governance service (optional) — FR-OBS, FR-HUM.7, FR-LRN

Node + Postgres, self-hostable, stateless API nodes.

| Module | Store | Notes |
|---|---|---|
| certificate registry | `certificates(digest pk, subject, body jsonb, signatures, issued_at)` | the trust store's source; workers can run from a local file instead |
| policy catalogue | `policies(name, version, digest, body, admitted_at)` + signed effect-class catalogue | FR-GRD.5 one vocabulary |
| ledger sink | `ledger_events(ns, wf, run, seq, kind, body jsonb, prev, hash)` partitioned by `ns, month`; `heads(ns, wf, run, seq, hash, sigs)` | append-only; insert conflicts on `(ns,wf,run,seq)` with a different hash are a **tamper alert** |
| verifier | — | `polyflow verify` as a service; nightly re-verification of chains; reconciliation against Cloud History Export |
| inbox | `orders`, `reviewer_load` | §6.2, §6.4 |
| Jev proxy | `jev_answers(digest, question, p, band, at)` | calibration (FR-JEV.5) |
| evidence | views over the above | FR-OBS.4 |
| console | static SPA | deep links into Temporal UI; never the only interface (FR-OPS.2) |

Exposed as HTTP/JSON and as a **Nexus service** (`PolyflowGovernance`:
`verifyRun` sync, `evidencePack` async, `requestApproval` async) so any
namespace can call it without network plumbing.

---

## 12. Observability (FR-OBS)

- OTel: the activity interceptor opens a span per governed effect with
  `gen_ai.*` attributes when the activity is a model call, plus
  `polyflow.level`, `polyflow.certificate`, `polyflow.state`,
  `polyflow.proposal.id`, `polyflow.verdict`, `polyflow.rules`,
  `polyflow.version_tuple`. Workflow-side spans are not emitted (replay); the
  verdict attributes travel on the ledger headers.
- Metrics (OpenMetrics from the worker): `polyflow_verdicts_total{rule,outcome}`,
  `polyflow_escalations_total{role}`, `polyflow_budget_used{metric}`,
  `polyflow_poisoned_total`, `polyflow_ledger_export_lag_seconds`.
- Run report (FR-OBS.5): `polyflow report <wf>` renders the run's ledger,
  certificate and chain verification to Markdown deterministically.

---

## 13. Security model

| Asset | Threat | Control |
|---|---|---|
| certificate | forged or stale machine | ed25519 signatures, trust store pinned per namespace, digest recomputed at worker start |
| ledger | tampering, deletion, reordering | hash chain; signed heads; server-ordered carrier (history); sink uniqueness alerts; reconciliation with History Export |
| policy | weakened silently | policy digest in every `admission` event; policy changes are a polyvers lane |
| approvals | replay, reuse, spoofed approver | per-effect binding (§6.3); verified principal (§5.7); four-eyes invariants |
| plan admission | malicious plan code | `node:vm` / isolate sandbox, CPU budget, no host imports, the parent's authority as ceiling |
| tool metadata (MCP) | description/schema poisoning | tool metadata digests pinned in the policy; change = new version (FR-AGT.4) |
| payloads | disclosure to vendor | digests only in the ledger; bodies stay under the customer's codec |
| keys | exfiltration from workers | deployment signing key per worker deployment, rotatable; the service co-signs heads so one key is not sufficient |

---

## 14. Testing strategy

| Layer | How | Gate |
|---|---|---|
| kernel | `node --test`; determinism double-run; property tests (random effect sequences) | 100% of rule types, witness shape |
| conformance | shared JSON corpus run by TS and Python | byte-identical outputs |
| Temporal binding | `@temporalio/testing` `TestWorkflowEnvironment` (local dev server, time skipping); the Replayer over recorded histories with `maxCachedWorkflows=0` | zero NDEs (NFR-4) |
| examples | customer-brief at G2: the polyflow e2e scenarios re-run on Temporal (happy path, denial, duplicate report, stale completion, restart) | parity with root `test/e2e.test.mjs` |
| agent | a scripted agent loop hitting a guard denial and re-planning | FR-GRD.3 acceptance |
| version gate | v1 → v2 fixture with fleet at mixed states | FR-VER.3 acceptance |
| cost | count billable-Action-generating events per run (history + updates + SA upserts) vs baseline | NFR-13 |
| DST | polyrun simulate over the same machine; Temporal test server with injected worker crashes | FR-SIM.1 |

---

## 15. Spikes (resolved in P0 before anything is built on them)

| # | Question | Pass criterion | Fallback |
|---|---|---|---|
| P0.1 | Temporal TS test server runs on this Windows machine | a workflow executes in `TestWorkflowEnvironment` | `createLocal` with a downloaded CLI dev server |
| P0.2 | A SAM v2 strict machine runs inside the TS workflow isolate (webpack bundle, no Node built-ins) | customer-brief steps inside a workflow, replay clean | vendor a trimmed strict-profile core into the kernel |
| P0.3 | Activity headers set in an outbound interceptor persist in history and reach the activity inbound interceptor | header round-trip visible in exported history | batched `polyflow.flush` local activity |
| P0.4 | Plugin interceptor ordering in TS | the guard observes the final input when another interceptor mutates it | document ordering; self-test at worker start |
| P0.5 | Principal Attribution readable from a workflow | — | signed principal header (§5.7) |
| P0.6 | QuickJS-Wasm in the Python sandbox within NFR-2 | p50 step < 1 ms | native acceptor code-gen |
