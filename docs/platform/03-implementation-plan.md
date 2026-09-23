# Polyflow for Temporal — implementation plan

Specs: [`01-functional-spec.md`](01-functional-spec.md),
[`02-technical-spec.md`](02-technical-spec.md). Evidence:
[`00-findings.md`](00-findings.md).

## Ground rules

- **Phases are interleaved with reviews.** Every phase ends with a written
  review (`reviews/P<n>-review.md`): what was built, what the tests prove, what
  a reviewer found, what was fixed, what is deferred and why. A phase is not
  done until its review's findings are fixed or explicitly deferred with a
  reason. Reviews are adversarial: a reviewer who did not write the code reads
  the diff against the spec and tries to break the acceptance claims.
- **Each step is one commit with a test that proves it**, ordered so nothing is
  built on an unverified assumption (the polyness plan's rule).
- **The far end first.** Spikes that could invalidate the design run before the
  code that depends on them.
- **Tests are named as claims** ("a denial is a result, not a fault").
- **No step claims more than its test shows.** The review checks the claim
  against the test.

## Phases

### P0 — Foundations and spikes

| # | Step | Test / pass criterion |
|---|---|---|
| 0.1 | `platform/` workspace; `packages/kernel` skeleton; `.gitattributes` pins LF | `npm test` runs in `platform/` |
| 0.2 | kernel: canonical JSON, pure SHA-256, digest | known-answer vectors (NIST SHA-256; canonical edge cases: key order, unicode, -0, nested) |
| 0.3 | Spike P0.1: Temporal TS test environment on this machine | a trivial workflow executes |
| 0.4 | Spike P0.2: SAM machine inside the workflow isolate | customer-brief steps in a workflow; replay clean |
| 0.5 | Spike P0.3/P0.4: ledger headers persist and reach the activity interceptor; ordering | header visible in fetched history and in the activity interceptor |

**Review P0.** Are the spike results real (not mocked)? Do they hold with
`maxCachedWorkflows: 0`?

### P1 — G0 Observe

| # | Step | Test |
|---|---|---|
| 1.1 | kernel `ledger.mjs`: events, chain, drain | chain verifies; any mutation/reorder/drop detected at the right seq |
| 1.2 | `temporal`: outbound interceptor records proposal/verdict/effect/observation; headers carrier; close flush | an unmodified agent-loop workflow's ledger has one effect per activity in history |
| 1.3 | activity-side exporter + JSONL sink + signer | exported events verify; re-delivery is idempotent |
| 1.4 | `cli`: `polyflow verify`, `polyflow export` (rebuild the ledger from a fetched history) | offline verify passes; a tampered bundle fails at the first bad link; export-from-history equals the sink |
| 1.5 | replay test: Replayer over recorded histories with the plugin | zero NDEs |

**Review P1.**

### P2 — G1 Guard

| # | Step | Test |
|---|---|---|
| 2.1 | kernel `policy.mjs`: parse, validate, satisfiability | unknown type refused; unsatisfiable rule refused; `guards` required |
| 2.2 | kernel `rules.mjs`: all rule types, combination, witness with `fix` | per-rule truth tables; determinism double-run; property test |
| 2.3 | guard in the outbound interceptor; `PolyflowDenied` failure; denial rides next carrier | denied activity never scheduled; denial present in the ledger |
| 2.4 | approvals bound per effect; `escalate` parks on an Update | CapLease scenarios: retry, replan-with-different-args, crash-after-approval |
| 2.5 | trifecta + budgets | fixtures from FR-GRD.6 and .7 |
| 2.6 | scripted agent loop re-plans after a witness | the loop's next call satisfies the rule |

**Review P2.**

### P3 — G2 Govern

| # | Step | Test |
|---|---|---|
| 3.1 | kernel `machine-host.mjs`: step, dryRun, poison | customer-brief happy path, rejects, poison on undeclared effect |
| 3.2 | `GovernedWorkflow`: load, loop, work-order activities, timers, queries, updates | root e2e scenarios re-run on Temporal |
| 3.3 | client: derived ids, signal-with-start / update-with-start | same input → one run; bad field → instruction |
| 3.4 | Continue-as-New with snapshot | forced CaN mid-run; final state and effect count unchanged |
| 3.5 | poison quarantine and release | poisoned run blocks, is visible, releases on Update |

**Review P3.**

### P4 — G3 Certify

| # | Step | Test |
|---|---|---|
| 4.1 | kernel `certificate.mjs`; `polyflow admit` (check-effects + structural + policy) | customer-brief certified; unsafe-brief refused with counterexample |
| 4.2 | worker refuses artefacts that do not match a signed certificate | one-line edit → worker fails naming the file |
| 4.3 | `polyflow vet`: polyvers lanes over snapshots | v1→v2 fixture: auto-upgrade / migrate / pin per run |
| 4.4 | `PolyflowGateWorkflow` | gate fails on an unsafe change, passes on a safe one |

**Review P4.**

### P5 — Agents and crews

| # | Step | Test |
|---|---|---|
| 5.1 | gateway: `Polyflow` surface over Temporal; root `makeTools` unchanged | MCP stdio test: start → report loop to terminal against Temporal |
| 5.2 | async completion for external agents; orders crossing CaN | report after CaN lands as a proposal |
| 5.3 | claims as Updates; roles; refused claim is an answer | two actors, one claim wins, only the holder can report |
| 5.4 | STOP from every non-terminal state | admission refuses a machine without it |
| 5.5 | **Verified principals** (tech spec §5.7): a signed `polyflow-principal` header checked against keys pinned in the policy; the `polyflow.approve` validator and order reports check the principal's role. Until this row lands, every approval and report is recorded `verified: false` and the review of P2 does not count FR-HUM.3's "spoofed approver" control as covered (P2/P3 review AP1) | an approval from a principal without the escalation's role is refused; an unsigned principal is refused when the policy pins keys |

**Review P5.**

### P6 — Judgement and plans

| # | Step | Test |
|---|---|---|
| 6.1 | `observe` effects; Jev client with bands; abstention → unknown | fixture answers; middle band yields no fact; replay never calls Jev |
| 6.2 | plan admission: step-list compiler + check under the parent's policy | admitted plan runs as child; refused plan returns counterexample |
| 6.3 | authority attenuation for plan children | child cannot order a kind the parent could not |

**Review P6.**

### P7 — Python

| # | Step | Test |
|---|---|---|
| 7.1 | conformance corpus generated from the TS kernel | corpus committed |
| 7.2 | `polyflow_temporal` kernel port (ledger, canonical, rules) | corpus byte-identical |
| 7.3 | Python plugin G0/G1 | OpenAI Agents SDK sample governed unmodified (requires `temporalio` + the integration) |
| 7.4 | Spike P0.6: QuickJS-Wasm evaluator for G2 | latency and conformance |

**Review P7.**

### P8 — Governance service and evidence

Certificate registry, policy catalogue, ledger sink with tamper alerts, inbox,
evidence pack, run report, OTel attributes, metrics, console. Each with its
acceptance test from FR-OBS/FR-LRN.

**Review P8.**

### P9 — Hardening and the acquisition evidence

- DST over governed workflows; pass^k harness.
- The FINDINGS-phase3 replication on Temporal (S3).
- Cost measurement per release (NFR-13).
- Security review of the whole platform; licence audit of every dependency.
- A write-up aimed at Temporal's AI team; partner-programme application.

**Review P9.**

## Added after external feedback 1

See [`reviews/external-feedback-1.md`](reviews/external-feedback-1.md).

| Step | What | Test that proves it |
|---|---|---|
| P2.6 | Ledger header bodies are encoded with the worker's payload codec (NFR-7). This must be done before any partner pilot. | A codec that encrypts: history holds no plaintext ledger text, and the sink still verifies |
| P4.6 | Policy ramp gate at G1: vet a new policy against the guard states of in-flight runs before promotion | A tightened budget that a run in flight has already been promised is reported, and the ramp is refused |
| P5.6 | Pre-approvals freeze their arguments: the effect must execute exactly the approved arguments | A model rewrite after pre-approval needs a new approval. The approved call executes unchanged |
| P7.3a | Spike: the OpenAI Agents SDK's activity shape for MCP tools; `classifyBy` an argument path | The guard classifies a tool called through a generic activity |
| P10 (optional) | A second engine binding at G0/G1 (Restate, DBOS or LangGraph), ledger and guard only | The same conformance corpus passes on the second engine |

## What is built in this session

P0 through as far as the reviews allow, in order. Anything not reached is
recorded in the status section below with the reason.

## Status

Updated 2026-09-22. "Built" means a test proves the row's claim, and the
phase's review has been answered.

| Phase | State | Review |
|---|---|---|
| P0 Foundations and spikes | **Built.** All four spikes ran against a real dev server (P0.1–P0.4). **P0.5** (Principal Attribution) was superseded by verified principals (P5.5): tokens are signed outside the worker and verified inside it, with no server feature needed. **P0.6** (QuickJS) is run as P7.4. | [`P0-P1-review.md`](reviews/P0-P1-review.md): 4 blockers and 12 majors, all fixed |
| P1 G0 Observe | **Built.** Ledger headers can be sealed with a worker-held data key (**P2.6**), because payload codecs skip headers. | same |
| P2 G1 Guard | **Built**, including escalation. **2.6** sealed headers are built. Routed classification lets one activity carry many tools (**P7.3a**). | [`P2-P3-review.md`](reviews/P2-P3-review.md): 2 blockers and 14 majors, fixed or narrowed |
| P3 G2 Govern | **Built**, including the Continue-as-New hand-over (P3.4) and quarantine/release (P3.5). | same |
| P4 G3 Certify | **Built.** `polyflow admit` checks the domain against the contract, state invariants, the module closure, batteries, and that every wait has an exit. The worker refuses uncertified machines. `polyflow vet` accepts admitted versions only. `PolyflowGateWorkflow` runs on Worker Versioning end to end: certified v1 and v2 deployment versions, gate before promotion, promote, wake, Upgrade-on-Continue-as-New. **4.6** policy ramp gate at G1 (`PolyflowPolicyGateWorkflow`) is built. | [`P4-P5-review.md`](reviews/P4-P5-review.md): 4 blockers and 15 majors. All fixed. VG3's search attribute is deferred with the P8 remainder. |
| P5 Agents and crews | **Built.** Gateway with the six unchanged polyflow tools plus `workflow_claim`. Operator-controlled external mode. Role-checked claims and reports. STOP required at admission. **5.5** verified principals (signed tokens, pure-JS ed25519 in the isolate) and **5.6** frozen arguments on approvals are built. | same |
| P6 Judgement and plans | **Built.** `noul` batteries are declared, validated at admission, and calibrated per JF3.2–3.5 against a named model. Out-of-range answers are `malformed`. Only declared `source` fields leave the worker, redacted. `score` is refused. `proposePlan` walks down-sets under an evaluation budget and refuses unbounded metered budgets. A failed plan cancels its other steps, and the outcome is recorded. **Not built:** plan children (6.3; plans run under the parent's guard), and the FR-JEV.5 tracking report (the record now holds the probabilities it needs). | [`P6-P8-review.md`](reviews/P6-P8-review.md): 2 blockers and 18 majors, all fixed |
| P7 Python | **Built for G0/G1.** The kernel port is byte-identical to TypeScript on the conformance corpus, including routes, `pick` and `redact` parity. The plugin governs activities, children, signals and Nexus. It redacts, spends budgets from dataclass and pydantic results, checks continuity, closes on cancel, and carries the guard across Continue-as-New. **7.3**: the OpenAI Agents SDK sample runs unmodified under G1 offline, with MCP tools classified by routed name, and its ledger verifies under the TypeScript CLI. **7.4** QuickJS G2: see its row in the spike doc. | same |
| P8 Service and evidence | **Built:** the sink holds back out-of-order deltas and refuses forks whole. Heads are verified. Tokens are scoped to namespaces. Certificate registry with digest check. Evidence pack that says "no runs in scope" instead of passing. Metrics derived from ledgers. Read-only console. OTel **attributes** (not timed spans). **Deferred until after the acquisition brief** (external feedback 1): Postgres store, inbox UI, policy catalogue service, Nexus facade, `PolyflowCertificate` search attribute. | same |
| P9 Hardening | **Built:** DST over governed runs (20 seeded schedules; sequential stimuli, scope stated in the test), pass^k harness (one task, seeded; framed as evidence of enforcement, not of model behaviour), NFR-13 per Temporal Cloud's Action table (+1 Action per execution; history 3.3× as protobuf, 4.2× sealed), security review and licence audit (all packages ship LICENSE), acquisition brief ([`04-acquisition-brief.md`](04-acquisition-brief.md)). **Open:** DST1-R (replay-unstable event times in a run's first activation fork the exported chain at a hand-over), S3 with a real model, compact header encoding, G2's half of NFR-13. | [`P9-security-review.md`](reviews/P9-security-review.md): 3 blockers and 15 majors, fixed (some parts deferred); [`P9-review.md`](reviews/P9-review.md): 3 blockers and 13 majors, fixed except DST1-R (open); licence audit [`P9-licence-audit.md`](reviews/P9-licence-audit.md) |
