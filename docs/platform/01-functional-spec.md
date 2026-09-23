# Polyflow for Temporal — functional specification

**Temporal makes an agent's work survive a crash. Polyflow makes it checkably
allowed.** Polyflow is the governance layer for agents that run on Temporal:
it checks the rules before a workflow can run, enforces them on every effect
while it runs, records every decision so someone else can verify it, and
gates every new version against the runs already in flight.

This document says **what** the platform does and **why**. The technical
specification (`02-technical-spec.md`) says how; the implementation plan
(`03-implementation-plan.md`) says in what order. The evidence behind every
requirement is in [`00-findings.md`](00-findings.md) and the four notes under
[`research/`](research/).

> Experimental. Every check is a **consistency check, not a proof**, and
> "exhaustive" always means exhaustive over the finite domains a contract
> declares. A verdict is a lead to act on, not a guarantee about the world.

Requirement ids are stable: `FR-<area>.<n>` for functional, `NFR-<n>` for
non-functional. Each carries **acceptance** — the observable fact that proves
it — and a **source**: `lit#n` (research/02 §11 rank), `G#`/`W#` (research/01
§3.2 gap / §3.3 Temporal weakness), `R#` (research/01 §3.1 table stake).

---

## 1. Scope and positioning

### 1.1 What it is

A set of packages and one optional service that a Temporal customer adds to
the workers, CI and namespaces they already run:

| Surface | For | Form |
|---|---|---|
| **Governance plugin** | platform engineers | a Temporal Worker plugin (Python, TypeScript) bundling interceptors, the governed-workflow host, and activity implementations |
| **`polyflow` CLI** | developers, CI | admit, certify, vet a version against the fleet, audit a history, export evidence |
| **Agent gateway** | agent developers | an MCP server exposing the work-order loop over a Temporal namespace; adapters for the OpenAI Agents SDK, Google ADK, Pydantic AI and LangGraph integrations Temporal already ships |
| **Governance service** (optional, self-hostable) | platform, risk, auditors | certificate registry, policy catalogue, ledger sink and verifier, the human inbox, the Jev proxy, a console. Also exposed as a **Nexus service** so any namespace can call it |
| **Standalone runtime** | local, edge, air-gapped, tests | polyrun, the snapshot-resumed engine, behind the same interfaces |

### 1.2 What it is not

- Not a durable-execution engine for Temporal customers. Temporal is the engine.
- Not an agent framework. Agents are whatever the customer uses; the platform
  governs their effects and, at G2, their control flow.
- Not a model provider and not a guardrail classifier for content. Content
  judgement comes from Jev as typed, calibrated observations — data the
  machine reads, never a verdict the model gives itself.
- Not a proof system. See the disclosure above.

### 1.3 The determinism dial

Four levels, adopted one at a time on existing workflows. Each is valuable
alone; each strictly contains the one before.

| Level | Deterministic | Agent keeps | Customer change |
|---|---|---|---|
| **G0 Observe** | the record | everything | register the plugin |
| **G1 Guard** | which effects may happen | loop, plan, tool choice | + a policy file |
| **G2 Govern** | what may happen next | how each step is done | workflow hosts a certified machine |
| **G3 Certify** | what may ship | authoring the next version | + CI gate, + ramp gate |

**Plans as proposals** (FR-PLAN) crosses all four: an agent may author a plan
at run time, and the platform checks it before it runs.

---

## 2. Personas

| Persona | Wants | Primary surfaces |
|---|---|---|
| **Platform engineer** (owns Temporal at the company) | governance without a migration, without new infrastructure to run, without NDEs | plugin, CLI, Worker Versioning gate |
| **Agent developer** | write agents in their framework; get told *why* something was refused, in terms they can fix | adapters, MCP gateway, witnesses |
| **Workflow owner** (a business role) | state rules in sentences; approve plans, not verbs | authoring, invariant elicitation, the inbox |
| **Approver / human participant** | see what they are approving, once, with context; not be flooded | the inbox, claims |
| **Risk and compliance officer** | evidence that rules held, by someone who did not produce it; EU AI Act readiness | ledger verifier, evidence pack, console |
| **SRE / operator** | pause, drain, retry, migrate safely; know what a run is waiting for | console, CLI, Temporal UI |
| **Auditor** (external) | verify a run's record offline, without the vendor | `polyflow verify`, exported bundle |

---

## 3. Functional requirements

### 3.1 FR-LED — the decision ledger (G0)

The record every other level builds on. *Source: G1, G3, lit#1, lit#4, R16.*

**FR-LED.1 Typed decision events.** Every governed interaction is recorded as
one of these event kinds (plus `closure`, which ends each execution), bound to the run and to the Temporal event that
carries it:

| Kind | Meaning |
|---|---|
| `proposal` | a typed action someone (model, tool result, human, timer, signal) proposes to the run |
| `verdict` | what the machine or guard decided about it: accepted, rejected(reason), denied(witness), escalated |
| `effect` | an effect the run ordered: kind, arguments digest, effect class, idempotency key |
| `observation` | the effect's result, or a Jev observation, as typed data |
| `admission` | the certificate (and policy version) the run was operating under |

*Acceptance:* for a G0 run of Temporal's OpenAI Agents SDK sample, every model
call and tool call appears as `proposal`/`effect`/`observation` triples, and
the count matches the activities in the Temporal event history exactly.

**FR-LED.2 Tamper evidence.** Events are hash-chained per run. Every head the
exporter ships is signed (ed25519) by the worker's deployment key and, when
present, by the governance service; the final head is written to the run's
memo at close (a memo write per workflow task would be a billable Action per
task). Every execution ends in a `closure` event, so a truncated record is
distinguishable from a finished one. *Acceptance:* altering, dropping or reordering any exported event makes
`polyflow verify` fail and name the first bad link.

**FR-LED.3 Offline verification.** `polyflow verify <bundle>` checks a run's
chain, signatures and certificate binding with no network and no vendor
service. *Acceptance:* runs on an air-gapped machine against an exported bundle.

**FR-LED.4 The window is the unit.** Every accepted or rejected step of a
governed machine is also a `{pre, action, data, post, step_kind, reject_reason}`
window — the ecosystem's universal record — so the ledger is a Polygraph trace
corpus without conversion. *Acceptance:* `polygraph audit` and
`polyrun audit` consume an exported ledger directly.

**FR-LED.5 Redaction before record.** Secrets are redacted before they are
hashed or written (the polyflow decision journal's redact-then-truncate rule);
payloads above a threshold are stored by content hash through Temporal's codec
/ external storage, never inline. *Acceptance:* a fixture carrying an API key
in a tool argument produces a ledger with no occurrence of the key and a valid
chain.

**FR-LED.6 Replay modes, named and separate.** *Source: lit#4.*
- **recovery** — Temporal's own replay; the plugin adds nothing that could
  diverge.
- **audit** — re-derive every verdict from recorded proposals through the
  certified machine and the pinned policy; never calls a model. Any difference
  is a finding.
- **what-if** — re-derive verdicts under a *different* policy or machine
  version, over recorded proposals: "which of last month's effects would the
  new rule have denied?"
- **counterfactual** — re-execute with live models under the simulator; results
  are distributions, reported as pass^k, never as a replay verdict.

*Acceptance:* audit replay of an unmodified run reports zero drift; what-if
replay of the customer-brief corpus under a rule that forbids posting on
weekends names exactly the weekend posts.

**FR-LED.7 Temporal-visible.** Governance status is visible in Temporal's own
tools: search attributes (`PolyflowLevel`, `PolyflowCertificate`,
`PolyflowState`, `PolyflowLastVerdict`, `PolyflowPendingApproval`), user
metadata summaries on activities ("guarded: allowed by no-post-without-approval"),
and memo (chain head). *Acceptance:* `temporal workflow list --query
"PolyflowLastVerdict='denied'"` returns exactly the runs with a denial.

### 3.2 FR-GRD — the effect guard (G1)

Enforce rules on effects without touching workflow code. *Source: G3, lit#6–9,
W8.*

**FR-GRD.1 Every effect crosses the guard.** Activity scheduling, child workflow
starts, Nexus operations and signals to external workflows are intercepted
before they are scheduled. So are tool calls made *inside* supported agent
frameworks (the OpenAI Agents SDK integration's tool and MCP activities).
*Acceptance:* no effect in the G0 corpus reaches the Temporal history without
a preceding `verdict` event.

**FR-GRD.2 Rules are sequences and state, not verbs.** A policy is a set of
obligations over the run's history of effects, in the ecosystem's shared rule
vocabulary: `no-X-without-a-prior-Y`, `at-most-n-X-per-run`,
`X-implies-a-prior-Y`, `never-X-after-Y`, plus budgets (tokens, cost, tool
calls, wall time), rate limits, and SAM policy machines for anything stateful.
The guarded effect is a declared field, never inferred from a rule's name.
*Acceptance:* the customer-brief policy denies a `post_brief` activity on a
path with no prior `APPROVED` and allows it on a path with one.

**FR-GRD.3 Deny with a witness.** A denial names the obligation, the concrete
bindings, the sequence that would violate it, and the effects allowed from the
current state. The agent receives it as a typed, non-retryable application
failure it can reason about. *Acceptance:* in a scripted agent loop, a denied
tool call is followed by a re-plan that satisfies the rule, not by a retry of
the same call. *Source: lit#6.*

**FR-GRD.4 Three outcomes, never a silent one.** `allow`, `deny(witness)`, or
`escalate(to role, budget)`. An escalation parks the effect until a principal
decides; the decision is recorded and bound to that one effect (FR-HUM.3).

**FR-GRD.5 Effect classes.** Every effect kind carries a consequence class —
`none | reversible | compensable | irreversible` — and, for trifecta rules,
labels: `reads-private`, `reads-untrusted`, `egress`. Classes come from one
signed catalogue (the merge of ACV 1.0 and polyaxion's label catalogue).
Irreversible effects are guarded by default; unlabelled effects are reported,
not silently allowed. *Source: lit#7, lit#8.*

**FR-GRD.6 The lethal trifecta is a rule.** A run that has read untrusted
content and holds private data may not perform an egress effect without an
approval, unless a declassification step the policy names has run.
*Acceptance:* a fixture that fetches a web page, reads a private document and
calls `send_email` is escalated; the same run without the web fetch is allowed.

**FR-GRD.7 Budgets are invariants.** Token, cost and call-count budgets are
enforced by the guard, not by retry configuration; exhausting one is a deny
with a witness naming the budget. What the guard can see is every effect the
*workflow* orders — so an agent loop that keeps re-asking a rate-limited model
stops at the budget. Retries the Temporal *server* performs for one scheduled
activity are one effect to the guard; bounding those is the activity's retry
policy, which the plugin records but does not rewrite. A reading the guard
cannot trust (a negative token count) closes the budget. *Source: G3.*

**FR-GRD.8 Replay safety.** The guard is a pure function of the recorded
history and the pinned policy. It never reads the clock, the network or a
mutable store inside workflow code. Policy updates take effect at a recorded
point (FR-LED.1 `admission`), never mid-task. *Acceptance:* 1,000 replays of
guarded histories under Temporal's replayer produce zero NDEs.

**FR-GRD.9 Fail narrow.** If the governance service is unreachable, the
in-process guard keeps deciding with the last pinned policy. A control-plane
outage never stops running work, and never turns a deny into an allow.

**FR-GRD.10 Policy admission.** A policy is itself admitted before use: its
machines are model-checked, its rules are checked for satisfiability (a rule
that denies every path is refused), and it is signed. *Source: doctrine "no
silent-clean paths".*

### 3.3 FR-GOV — governed workflows (G2)

The machine decides what happens next; the agent decides how. *Source: G1,
lit#1, lit#3, lit#5.*

**FR-GOV.1 A governed workflow hosts a certified machine.** A
`GovernedWorkflow` is a generic Temporal workflow that loads a certified SAM v2
strict-profile machine by certificate hash and runs it. Its only code is the
interpreter; the machine is pure. *Acceptance:* the customer-brief workflow runs
unmodified from `workflows/customer-brief/` on Temporal.

**FR-GOV.2 Effects are work orders.** Every effect the machine emits becomes an
activity — a *work order* — addressed to a tool, an agent, Jev or a human role.
Its completion (success, retryable failure, permanent failure) becomes the
declared completion action and is proposed back to the machine. *Acceptance:*
parity with polyflow's six-tool loop.

**FR-GOV.3 Observable rejection.** A proposal that does not apply in the
current state is a recorded reject with a contract-anchored reason, never an
error and never a crash. Duplicate reports, stale completions and late timers
all land as rejects. *Acceptance:* delivering every completion twice leaves the
final state and the effect count unchanged.

**FR-GOV.4 Done is a state.** A governed run is complete only when its machine
reaches a declared terminal state. An agent's claim of completion is a
proposal like any other. *Source: lit#3.*

**FR-GOV.5 Derived identity.** A governed run's workflow id is derived from
validated input fields by the workflow's key template (polyflow's `deriveKey`),
never chosen by a model. Starting and re-attaching are one call
(signal-with-start / update-with-start). *Acceptance:* two starts with the same
input produce one run; a start with an invalid field is refused with an
instruction, not a new id.

**FR-GOV.6 State-projected context.** Every work order carries a context
projected from the machine state and the invariants relevant to that step —
not a transcript. Transcripts and documents live in external storage by
content hash and are referenced, not replayed. *Source: lit#5, G6, W3.*
*Acceptance:* a governed agent run of 500 model calls stays under 10% of
Temporal's history-size limit.

**FR-GOV.7 Signals, queries and updates.** Out-of-band events are machine
actions delivered by Update (synchronous accept/reject with reason) or Signal
(fire-and-forget, recorded). The machine state, open orders and armed timers
are queryable. *Acceptance:* `temporal workflow query --type polyflow.state`
returns the machine state and open orders.

**FR-GOV.8 Timers and waits.** Every waiting state arms a timer
(admission-checked: a waiting state with no timer is refused, MA-11). Waits cost
no compute.

**FR-GOV.9 Composition.** Governed workflows compose as parent and child;
cross-machine invariants are checked at admission (`check-product`); cancelling
a parent cancels or compensates its children as the parent's machine declares.
*Source: G5.* *Acceptance:* no orphaned child after a parent cancel in the
composition fixture.

**FR-GOV.10 Compensation.** A machine may declare compensations for
`compensable` effects; entering a compensating state emits them in reverse
order, and "every compensable effect is compensated on every failed path" is an
invariant the gate can check.

**FR-GOV.11 Poisoning.** A certified machine that does something impossible
(throws, emits an undeclared effect, fails its frame check) quarantines the run
with the reason, visible in the Temporal UI; it is never silently retried.

### 3.4 FR-ADM — admission and certificates (G3)

Nothing runs on the strength of "it worked once". *Source: G2, lit#2, D1.*

**FR-ADM.1 The certificate.** Admission produces a signed certificate carrying:
content hashes of every artefact (contract, machine, effects, manifest,
invariants, effect invariants, migrations, policy), the invariant names (the
sentences being approved), the checks run, paths explored, states seen,
whether exploration was bounded, the adequacy grade, the declared domains, the
toolchain versions, and the signer.

**FR-ADM.2 Bounded is not a pass.** A check that hits its depth or path ceiling
refuses admission unless the owner accepts the bound explicitly, and the
acceptance is recorded in the certificate.

**FR-ADM.3 Workers refuse unverified machines.** The plugin will not register a
governed workflow, or load a machine, whose artefacts do not match a valid
certificate. *Acceptance:* editing one line of `machine.cjs` after admission
makes the worker refuse to start with a message naming the file.

**FR-ADM.4 CI gate.** `polyflow admit` runs in CI and fails the build on any
violation, printing the shortest counterexample path.

**FR-ADM.5 Structural checks.** Beyond invariants: every waiting state arms a
timer; every role named by an order is satisfiable; every effect kind has a
consequence class; every irreversible effect is guarded; no reachable state
without an exit other than a terminal.

**FR-ADM.6 The certificate is the version.** A certificate hash maps onto a
Temporal Worker Deployment Version's build id. There is no second version
number to keep in sync.

### 3.5 FR-VER — versioning against the live fleet (G3)

*Source: G4, W2, lit#11.*

**FR-VER.1 Lanes before ramp.** Before a new deployment version ramps, polyvers
classifies the change into lanes — semantic, shape, migration, vocabulary,
intent, composition — and runs every gate each lane requires against **fleet
snapshots**: the machine state of every running governed workflow, pulled by
Query.

**FR-VER.2 Per-run decisions.** The gate's output is per run: *auto-upgrade
safe*, *pin*, or *migrate with `migrate.cjs`*. It is applied through Worker
Versioning (versioning-behavior override per workflow) and recorded as an
`admission` event in each affected run's ledger.

**FR-VER.3 Migrations are checked, not hoped.** A migration is a pure function
over state, validated against every live snapshot: it must round-trip, and
every invariant must hold on the migrated state. *Acceptance:* the fixture's
v1 → v2 change with an added state key auto-upgrades its idle runs, migrates
its in-review runs, and pins the one run whose state has no image.

**FR-VER.4 Non-code artefacts version too.** Prompt templates, model and
serving config, tool schemas and policies each carry a content hash; the
version identity of a step is the tuple. A change to any of them is a lane
(prompt or model changes are the *semantic* lane for the steps that use them)
and is recorded on every event. *Source: G4, lit#11.*

**FR-VER.5 An empty corpus is refused.** A version gate with no fleet snapshots
and no declared synthetic corpus does not pass; it says so.

**FR-VER.6 Worker controller integration.** The ramp gate runs as a check the
temporal-worker-controller (Kubernetes) consults before it advances a ramp.

### 3.6 FR-HUM — humans and multiple agents (polycrew)

*Source: G5, lit#9, lit#10, lit#17.*

**FR-HUM.1 Principals.** Every participant — human, agent, service — is a
principal with a verified identity from the customer's IdP (OIDC) or workload
identity (SPIFFE / Temporal API key / mTLS). Actor ids are never taken from
tool arguments. Where Temporal's Principal Attribution is available, it is the
source.

**FR-HUM.2 Roles and claims.** A work order may be addressed to a role. A
principal holding the role claims it; a claim is a lease; only the holder may
report; a refused claim is an answer naming the holder, not an error.
Implemented as workflow Updates, so claim races are resolved by the workflow.

**FR-HUM.3 Approvals bind to one action.** An approval names the exact effect
(kind, argument digest, run, step) it authorises and is consumed by exactly one
execution of it. A retry, a re-plan with different arguments, or a restart
cannot reuse it. *Acceptance:* the CapLease scenarios — retry after approval,
replan with changed amount, crash after approval — each either reuse nothing or
request a fresh approval.

**FR-HUM.4 Four-eyes and separation of duties** are invariants over principals
("the approver is not the requester"), checkable at admission over role
declarations and enforced at run time over verified identities.

**FR-HUM.5 Oversight has a budget.** Escalations per reviewer per hour are
bounded; excess escalations queue with priority by consequence class; a spike
in escalations is itself an alert. *Source: lit#10.*

**FR-HUM.6 A stop is always available.** Every governed run accepts a `STOP`
from an authorised principal from every non-terminal state, leading to a
declared safe terminal. The admission gate checks this (EU AI Act Art. 14).

**FR-HUM.7 The inbox.** Humans see open orders addressed to their roles, with
the context projected for the step, the rule that required them, and what
happens on yes and on no. Available as a console page, a Slack/Teams message
and an MCP tool, all backed by the same Update.

**FR-HUM.8 Multi-agent crews.** Several agents work one run through the same
claim protocol. Agents never message each other; they propose to the run.
Fan-out and join are machine states with mandatory timers.

### 3.7 FR-JEV — calibrated judgement

*Source: lit#12, D7.*

**FR-JEV.1 Jev is an effect kind.** A machine may declare `observe` effects: a
battery of typed questions (`noul`, `choice`, `score`) over a projected state.
The answer comes back as data and is proposed as an action like any other
result.

**FR-JEV.2 Bands and abstention.** Each question declares an assert band and a
refute band. An answer in the uncertain middle yields *no fact* — never a
default false — and the machine's contract decides what "unknown" does
(typically: escalate to a human role).

**FR-JEV.3 Frozen on record.** A Jev answer is recorded once and read back on
every replay; Jev is never called during audit or recovery replay.

**FR-JEV.4 No judge in an acceptor.** Acceptors read observations; they never
call a judge. The admission gate refuses a machine that imports a network
client.

**FR-JEV.5 Calibration is tracked.** Human decisions on escalated observations
are labels. The platform reports per-question agreement and drift, so a band
that has stopped being calibrated is visible.

### 3.8 FR-PLAN — plans as proposals

The move nobody ships. *Source: G2, D8.*

**FR-PLAN.1 An agent may author a plan.** Within a governed or guarded run, an
agent may propose a plan: a small SAM machine (or a declarative step list the
platform compiles to one) plus the effects it will order.

**FR-PLAN.2 Admission at run time.** The plan is model-checked against the
organisation's invariants and the parent run's policy, inside an activity. Its
verdict is recorded like any other result. An admitted plan runs as a child
governed workflow; a refused plan returns its counterexample as a witness so
the agent can revise it.

**FR-PLAN.3 Bounded cost.** Run-time admission has a declared exploration
budget. A plan that cannot be checked within it is refused as *bounded*, not
admitted.

**FR-PLAN.4 Authority attenuates.** A plan's child run can order only effects
the parent was allowed to order, with at most the parent's remaining budget.

### 3.9 FR-AUTH — authoring and elicitation

*Source: research/02 §10 "specification is the bottleneck".*

**FR-AUTH.1 From sentences to a certified workflow.** A workflow owner describes
the process in prose; polygen drafts the contract and machine; polynv proposes
invariants with a pre-computed verdict and counterexample for each; the owner
confirms, rejects or edits; polygen self-repairs the machine (never the
invariants) until admission passes.

**FR-AUTH.2 Every invariant has an owner and a sentence.** Invariants are
approved as sentences by named principals; the intent ledger records who
agreed to what and when.

**FR-AUTH.3 Templates.** A library of governed-workflow shapes common in
agentic work — approve-then-act, research-draft-review-publish, triage-and-route,
reconcile, scheduled report, incident response — each shipped certified.

**FR-AUTH.4 From the ledger.** polyness and polyx read the platform's own
ledger and propose workflows and rules the history supports, with support,
counter-examples and the date mined (FR-LRN).

### 3.10 FR-LRN — learning from the ledger

*Source: lit#13, D9.*

**FR-LRN.1 Mined rules are suggestions.** A rule mined from the ledger is
presented with its support, its counter-examples and its provenance, and
enters enforcement only through FR-AUTH.2 adjudication and FR-ADM admission.

**FR-LRN.2 Denials are data.** Every denial, and every override of a denial
(a principal ran it anyway), is recorded. The override rate is a rule's
measured false-positive rate; a rule can be retired on that evidence.

**FR-LRN.3 What-if before adopt.** Before a rule is adopted it is replayed over
recorded history (FR-LED.6 what-if) and reported as: would have denied n
effects, of which m were later overridden.

**FR-LRN.4 Process-mining export.** The ledger exports as OCEL 2.0.

### 3.11 FR-AGT — agent integrations

*Source: R6, S4.*

**FR-AGT.1 OpenAI Agents SDK on Temporal.** The plugin composes with
`temporalio.contrib.openai_agents`: model calls and tool calls it already runs
as activities are recorded (G0) and guarded (G1) without changing agent code.

**FR-AGT.2 Google ADK, Pydantic AI, LangGraph** — the same, for each
integration Temporal ships, in priority order of Temporal's customer adoption.

**FR-AGT.3 MCP gateway.** An MCP server exposes the six work-order tools
(`workflow_list`, `workflow_start`, `workflow_report`, `workflow_state`,
`workflow_signal`, `workflow_journal`) plus polycrew's `workflow_next` and
`workflow_claim`, backed by a Temporal namespace. Any MCP-capable agent — Claude
Code, OpenWorker, Kiro — can be a participant in a governed run.

**FR-AGT.4 MCP tool governance.** Tool metadata from MCP servers is pinned and
hashed at admission; a changed description or schema is a new version, not a
silent update (tool-poisoning defence). *Source: lit#19.*

**FR-AGT.5 Streaming.** Token streams from model activities reach the caller
through Temporal's streaming mechanism; the ledger records the final output,
not the stream.

**FR-AGT.6 Temporal Agent Harness.** When the Harness is present, the platform
plugs in as a policy predicate (`PolyPredicate`) behind its tool-approval
layer, so a Harness user gets checked rules and witnesses without replacing
the Harness. Optional adapter: the Harness is pre-preview.

### 3.12 FR-OBS — observability and evidence

**FR-OBS.1 OTel.** Spans follow the OTel GenAI conventions (behind an adapter
while they remain in development) and carry governance attributes: level,
certificate, machine state, proposal id, verdict, rule ids, version tuple.

**FR-OBS.2 Metrics.** Verdicts by rule and outcome, escalations and reviewer
load, budget consumption, admission results, version-gate outcomes, poisoned
runs — as OpenMetrics.

**FR-OBS.3 Diagrams.** Deterministic diagrams of machines, invariants,
counterexamples and version gates (polyviz), linked from the console and
attachable to a pull request.

**FR-OBS.4 Evidence pack.** For a namespace and a period: certificates in
force, policies and their versions, verdict statistics, overrides, human
oversight events, version gates run, ledger verification results — mapped to
EU AI Act Art. 12/13/14/19, ISO/IEC 42001 and NIST AI RMF headings.
*Source: lit#16.*

**FR-OBS.5 Run report.** A deterministic one-page report per run: what it did,
under which certificate, which rules fired, who approved what, and the chain
head.

### 3.13 FR-SIM — simulation and reliability

**FR-SIM.1 Deterministic simulation.** A governed workflow can be simulated with
stubbed or recorded agents, injected faults (duplicate and stale deliveries,
activity failures, worker crashes) and a virtual clock; the machine's model is
stepped in lockstep so model/runtime drift is a finding.

**FR-SIM.2 pass^k.** Counterfactual runs with live models report pass^k per
workflow and per version; it is the headline reliability number the console
shows. *Source: lit#20.*

### 3.14 FR-OPS — operations

**FR-OPS.1** Pause, resume, stop, retry a work order, reassign a claim, and
migrate a run — each a machine action where the machine allows it, recorded,
and authorised by role.

**FR-OPS.2** Everything available in the console is available in the CLI and
the API; the console is never the only way.

**FR-OPS.3** Bulk operations (migrate all runs in state S; re-escalate all
expired claims) are dry-run first and report per run.

---

## 4. Non-functional requirements

| Id | Requirement | Target |
|---|---|---|
| NFR-1 | **Guard latency** in-process | p99 ≤ 2 ms per effect (polyaxion measured 0.63 ms) |
| NFR-2 | **Governed step overhead** vs a plain Temporal activity round trip | ≤ 5% of workflow-task time at p50 |
| NFR-3 | **History footprint** of G0 ledger events | ≤ 1 extra history event per effect; ledger bodies in external storage |
| NFR-4 | **Replay safety** | zero NDEs introduced by the plugin across the replay test corpus (Temporal Replayer) |
| NFR-5 | **Availability** | control-plane outage never blocks running work (FR-GRD.9); the plugin has no runtime dependency on the service at G0–G2 |
| NFR-6 | **Languages** | Python and TypeScript at GA; Go and Java plugins at G0–G1 next |
| NFR-7 | **Data protection** | compatible with customer codecs and codec servers; the service never needs plaintext payloads, only digests and typed actions the customer chooses to share |
| NFR-8 | **Tenancy** | namespace-scoped: certificates, policies, ledgers and principals never cross a Temporal namespace without an explicit Nexus endpoint |
| NFR-9 | **Determinism of our own tools** | every check, report and diagram is byte-identical for identical inputs; no model call in any gate |
| NFR-10 | **Licence** | plugin, CLI, gateway and verifier Apache-2.0; nothing in the Temporal-facing path depends on a non-Apache component |
| NFR-11 | **Supply chain** | signed releases, SBOM, reproducible builds for the plugin |
| NFR-12 | **Scale** | the governance service handles 10k verdict events/s per namespace on one Postgres; ledger sink is append-only and horizontally partitioned by run |
| NFR-13 | **Billable overhead** on Temporal Cloud | G0–G1 add **< 10%** billable Actions to a governed workflow vs the same workflow ungoverned; G2 adds < 10% vs an equivalent hand-written workflow. Measured and published per release |
| NFR-14 | **GA seams only** on the critical path | plugins, interceptors, Updates, Worker Versioning, Replayer, Nexus; preview features are optional adapters |

---

## 5. Doctrines (binding on every requirement above)

1. **Consistency check, not a proof.** Every report opens with its scope.
2. **No silent-clean paths.** Bounded is not a pass. Empty invariant sets,
   empty corpora and unlabelled effects are refused or reported, never green.
3. **Observable rejection.** A reject is a result with a reason.
4. **Witnesses, not refusals.** Every denial explains itself in terms the agent
   can act on.
5. **No model on the decision path.** Models interpret, propose and fulfil;
   engines decide.
6. **Anything a model can name, a model can name wrongly.** Identities, run
   keys, actors and versions are derived or minted.
7. **Absent evidence is unobserved, never clean.**
8. **The repair loop fixes code, never invariants.**
9. **Narrow fail-closed.** The blast radius of a failure equals its promise; a
   control-plane outage never stops running things.
10. **Temporal first.** Anything Temporal already does, we use rather than
    rebuild, and anything we add appears in Temporal's own tools.

---

## 6. Success criteria

The acquisition thesis is measured, not asserted.

| # | Criterion | Measured by |
|---|---|---|
| S1 | A Temporal customer reaches G1 in under a day on an existing workflow, without editing workflow code | design-partner onboarding logs |
| S2 | Temporal's OpenAI Agents SDK samples run at G0/G1 unmodified | CI against the upstream samples repo |
| S3 | The double-post / double-charge class is eliminated in the replicated FINDINGS-phase3 study on Temporal | 0 of n vs n of n, published with records |
| S4 | pass^k improves on at least two public agent benchmarks under G2 vs the same agent ungoverned | τ²-bench retail/airline, published |
| S5 | A version change with in-flight runs ships with zero NDEs and zero manual forks | the versioning fixture and a design partner's upgrade |
| S6 | An external auditor verifies a run offline | `polyflow verify` on an exported bundle, by someone outside the team |
| S7 | Three design partners on Temporal Cloud, one regulated (finance or health) | signed LOIs |

---

## 7. Out of scope for v1

- A durable engine for Temporal customers (polyrun is standalone only).
- Content moderation or toxicity classification.
- Model hosting, fine-tuning, prompt optimisation.
- Guarantees over data outside declared domains.
- Auto-promotion of mined rules.
- Non-Temporal engines (Restate, DBOS, Dapr) — the interfaces allow them; the
  acquisition thesis does not ask for them.
