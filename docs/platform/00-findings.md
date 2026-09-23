# Governed agents on Temporal — findings

**Temporal makes an agent's work survive a crash. Nobody makes it checkably
allowed.** This note closes the literature search. It states what the
platform is, who it is for, what the evidence supports, and what it does not.
The functional spec (`01-functional-spec.md`), technical spec
(`02-technical-spec.md`) and implementation plan (`03-implementation-plan.md`)
are written from it.

Sources, each with a URL on every claim:

| | |
|---|---|
| [`research/01-durable-execution-landscape.md`](research/01-durable-execution-landscape.md) | 24 durable-execution and agent systems, Temporal in depth |
| [`research/02-agentic-ai-literature.md`](research/02-agentic-ai-literature.md) | why agents fail, determinism, runtime enforcement, security, HITL, regulation |
| [`research/03-poly-ecosystem-inventory.md`](research/03-poly-ecosystem-inventory.md) | what we already have, read from code and tests |
| [`research/04-temporal-integration-surface.md`](research/04-temporal-integration-surface.md) | Temporal's extension points, per SDK, and the native mapping of each capability |

> Experimental, unproven, not peer-reviewed. Many 2026 sources cited in the
> research notes are single-author preprints; their numbers are indicative.
> Every check this platform performs is a **consistency check, not a proof**,
> exhaustive only over the finite domains a contract declares.

---

## 1. The decision this note records

**We build the governance layer Temporal does not have, and we build it on
Temporal.** Not beside it and not instead of it.

The exit is an acquisition by Temporal. That settles three things before any
technical argument:

1. **A Temporal customer adopts it without migrating a single workflow.** It
   arrives as a worker plugin, interceptors, a Nexus service and a CI gate. It
   shows up in the Temporal UI, in event histories, in search attributes and in
   `temporal` CLI output. Nothing asks the customer to leave.
2. **It never competes on durability.** Temporal is at $12.55B with a $250M+
   run rate growing 200% a year; AWS, Azure, Cloudflare and Vercel are
   commoditising durable execution underneath it. Durability is theirs. The
   thing to own is the layer Mistral had to build on top of Temporal for its
   Workflows product, taken much further (research/01 §1.1, §3.3).
3. **polyrun remains, as the second runtime.** A snapshot-resumed engine is the
   right tool for local development, the edge, air-gapped installs and the
   ecosystem's own verification flywheel (simulate, audit, deploy gates). It is
   also the reference implementation the Temporal binding is tested against.
   It is not what we sell to Temporal's customers.

---

## 2. The problem, as the evidence states it

### 2.1 In an agent loop, the model's output is the control flow

The industry has converged on one pattern: deterministic orchestration code,
with LLM calls and tool calls as memoised side effects (research/01 §0.2).
Temporal, Restate, DBOS, Inngest, Dapr, Azure Durable Task, AWS Lambda durable
functions and Cloudflare all do a version of it.

It solves recovery. It does not solve control. In an agent, the model picks the
next tool, the next sub-agent, whether to stop. Replay reproduces **what
happened**. It has nothing to say about **whether it was allowed**, and no
engine records *proposal → verdict → effect → observation* as separate,
checkable events (research/01 G1; Proof of Execution, arXiv 2607.05397).

### 2.2 Agents fail on control, not on intelligence

- MAST: most multi-agent failures come from system design and missing
  verification, not model capability (arXiv 2503.13657).
- **False success** — the agent says it finished when it did not — is 45–76% of
  failures in several domains (arXiv 2606.09863).
- Models get worse once their own errors are in context (arXiv 2509.09677).
  Context rot and compaction lose constraints; our own measurement: **1.7%** of
  hard constraints survive harness generation and **0%** survive two
  compaction rounds (polyjit).
- pass^k — succeeding on *every* one of k attempts — falls steeply with k
  (τ-bench, τ²-bench). Enterprises buy pass^k, not pass@1.

### 2.3 Structure helps capability, not only safety

Hard structure around the model *raises* task success: rule conformance from
77% to 100% with utility up (Agent-C, arXiv 2512.23738); 96% fewer constraint
violations (Blueprint-First, 2508.02721); 84.6% vs 30.8% for LangGraph at 8×
fewer tokens (PatchBoard, 2605.29313). Our own result: a scheduled job that
fires twice posted twice in **8 of 8** runs without polyflow and **0 of 8**
with it, on two harnesses (`FINDINGS-phase3.md`).

### 2.4 Security by design requires it

CaMeL, the six design-patterns paper and FIDES all require that untrusted
content never decides control flow (arXiv 2503.18813, 2506.08837, 2505.23643).
A machine that decides WHAT while the model decides HOW gives that
structurally; the "lethal trifecta" becomes an invariant a model checker can
refuse.

### 2.5 Regulation asks for exactly the by-products

EU AI Act Art. 12 (lifetime automatic logging), Art. 14 (human oversight, an
always-available stop), Art. 19/26 (retention ≥ 6 months). The Digital Omnibus
moved high-risk obligations to **2 Dec 2027** (Annex III) and **2 Aug 2028**
(Annex I). Buyers are planning now. NIST opened an AI Agent Standards
Initiative in Feb 2026 (research/02 §8).

### 2.6 Temporal's specific gaps for agents

| Gap | Evidence (research/01 §1.1, §3.3) |
|---|---|
| No governance semantics: no policy verdict per effect, no plan verification, no tamper-evident decision ledger; Principal Attribution pre-release | Replay 2026 announcements |
| In-flight versioning: patch branches accumulate; pinning keeps old workers forever; "impossible to properly upgrade inflight workflow without manually forking" | Worker Versioning docs; HN |
| NDEs: incompatibility found at replay, after deploy | Temporal docs; practitioner reports |
| History limits hostile to agents: 51,200 events / 50 MB; 2 MB payload; an agent hit the cap at model call ~53 | sdk-python #1890 |
| Tool output flows straight back into the model; no hook between them | xgrid (secondary) |
| Humans are a signal with a timeout; orphaned child agents after cancel | xgrid; LangGraph #6208 |

Each of these is either a direct application of what the Poly stack already
does, or a small extension of it (§4).

### 2.7 Governance is already contested inside Temporal's ecosystem

Research/04 §2 changes the positioning, not the thesis:

- **OpenBox** holds the "Governance" slot in Temporal's AI partner programme,
  with a joint launch on 2026-07-13. It evaluates lifecycle events through a
  remote call made from a `send_governance_event` activity, and it **fails
  open** by default.
- **Tenuo** carries signed, attenuated warrants in Temporal headers and checks
  them in an activity interceptor.
- **Temporal's own Agent Harness** (previewed 2026-08-20) ships tool-call
  approval policies — "a seam between the model deciding to use a capability
  and that capability actually executing" — and lists "policy engines" as
  future integrations. It mentions no verification.

None of them checks a workflow before it runs, checks a new version against
the runs in flight, or abstains with calibration. Runtime policy alone is
becoming a feature Temporal will own. **We position as the verifier behind the
Harness and beside OpenBox, not as a rival runtime-policy product**: the
checks that happen *before* anything runs (admission, version gates, plan
admission) and the evidence that can be checked *after* (the ledger), with a
runtime guard that is deterministic and in-process rather than a remote call.

Two design constraints follow directly from Temporal's billing and limits
(research/04 §4):

- **Governance must cost almost no Actions.** Updates (accepted *or*
  rejected), search-attribute upserts, heartbeats and every extra activity are
  billed. A remote verdict per tool call can double a customer's bill. The
  guard runs inside the workflow, pure, at zero Actions; ledger records ride
  on headers of activities that were going to be scheduled anyway (technical
  spec §5). "Governance adds under 10% Actions" is a claim we measure and sell.
- **Only GA seams on the critical path.** Plugins, interceptors, Updates,
  Worker Versioning, the Replayer and Nexus. Workflow Streams, External
  Storage, Principal Attribution and the Harness are optional adapters.

---

## 3. What the literature says to build, and where it says to be careful

### 3.1 Supported, in rank order (research/02 §11, condensed)

1. **Typed proposals at the boundary.** Every model output that could cause an
   effect enters as a typed proposal, journaled before any effect, accepted or
   rejected by the machine.
2. **One artefact, three times.** The same SAM machine and invariants are
   model-checked at design time, enforce at run time, and are the replay oracle
   at audit time.
3. **"Done" is a terminal state, never a claim.** Directly targets false success.
4. **Three replay modes, never confused:** recovery (recorded outputs), audit
   (re-derive every decision from recorded proposals — never call the model
   again), counterfactual (re-execute, report pass^k).
5. **Constraints outside the context window**; each step's prompt is projected
   from verified state.
6. **Rejections carry witnesses** — the rule, the bindings, the actions allowed
   from here — so the agent re-plans instead of routing around the block.
7. **Information-flow labels** on state and proposals.
8. **Effect classes** — none / reversible / compensable / irreversible — with
   compensation for the middle two and gating for the last.
9. **Approvals bound to one action and consumed exactly once**, surviving
   retries, replans and crashes (CapLease, arXiv 2608.01710).
10. **Budgeted human oversight**: escalation is a transition, reviewer load is
    tracked, flooding is itself a signal (arXiv 2606.08919).
11. **Version-safe evolution** with mechanical gates over live instances.
12. **Layered evaluation**: deterministic checks → small calibrated classifiers
    → sampled LLM judges. A TF-IDF detector beat the best LLM judge at false
    success (AUROC 0.83–0.95 vs ≤ 0.65) and ran 3,300× faster.
13. **Mined rules are suggestions** until elicited, model-checked and deployed.
14. OCEL 2.0 export; 15. OTel GenAI spans with governance attributes;
    16. a compliance evidence pack; 17. typed shared state for multi-agent work;
    18. Cedar/OPA interop; 19. an MCP governance gateway; 20. deterministic
    simulation, with pass^k as the headline SLO.

### 3.2 Where the thesis is exposed

- **Writing the rules is the bottleneck.** NL→formal-spec translation is
  24–35% semantically correct (arXiv 2608.14590). A model checker proves the
  wrong property with total confidence if the property is wrong. Elicitation
  (polynv), mined support (polyx) and human adjudication are not optional
  features; they are the product's weakest link and must be first-class.
- **The verifier tax.** Blocking 94% of unsafe actions did not make tasks safe;
  agents route around blocks. Hence witnesses and re-planning (§3.1.6).
- **Over-structuring caps capability.** As models improve, a machine that
  micromanages reasoning becomes a ceiling. The machine constrains *effects and
  outcomes*, never the reasoning inside a step.
- **Replay holds only while the model holds.** Swapping models rewrites 61–94%
  of later actions (arXiv 2608.08239). Audit replay must reuse recorded
  proposals. Temperature 0 is not deterministic.
- **Crowding.** AWS AgentCore (Cedar at the gateway), LangGraph, Camunda, a wave
  of 2026 governance papers. The differentiator is the single verified artefact
  across design, run and audit time, plus version-safe evolution — not policy
  checks alone, which are becoming commodity.

---

## 4. The platform in one picture

```
             author ──────────► verify ──────────► version ──────────► run ──────────► learn
            polygen            polygraph           polyvers        Temporal (+polyrun)  polyx
            polynv             check-effects       lanes over      + governance         polyness
            polyness           check-product       fleet snapshots   plugin             decision
                               polyaxion admit                     polycrew claims       journal
                                                                   Jev observations
                                         ▲                                  │
                                         └──────── signed certificate ◄─────┘
                                                    decision ledger
```

### 4.1 The determinism dial

The theme — *some determinism, without disrupting what makes agents smart* — is
a dial, not a switch. A customer turns it one notch at a time, on the workflows
they already have. Every notch is useful alone.

| Level | Name | What is deterministic | What the agent keeps | Adoption cost on Temporal |
|---|---|---|---|---|
| **G0** | **Observe** | the record: every activity and model/tool call becomes a typed decision event in a hash-chained ledger | everything | add the plugin; no code change |
| **G1** | **Guard** | effects: each outbound activity / tool call crosses a deterministic policy gate (sequence rules, budgets, trifecta, approvals bound to one action). Deny carries a witness | the loop, the plan, tool choice | plugin + a policy file; still no workflow change |
| **G2** | **Govern** | control flow: a certified SAM machine decides what may happen next; the agent fulfils work orders and proposes typed results | *how* each step is done: reasoning, tool use inside the step, sub-agents under a budget | the workflow becomes a `GovernedWorkflow` hosting a machine |
| **G3** | **Certify** | change: the machine, its invariants, effects and migrations are model-checked before admission, and every new version is gated against the live fleet | *what the next version should be* — agents may author it; they cannot ship it unchecked | CI gate + Worker Versioning ramp gate |

A fifth mode crosses all four: **plans as proposals.** An agent may author a
plan — a small machine — at run time. The platform model-checks it against the
organisation's invariants inside an activity (its verdict recorded like any
other result) and runs it as a child workflow only if it is admitted. This is
the move nobody ships (research/01 G2): the agent stays free to plan, and the
plan it chose is checked before it acts.

### 4.2 Why snapshots-not-replay still matters on Temporal

polyrun's inversion — resume from a snapshot, not a replay — is the
ecosystem's answer to Temporal's determinism tax. On Temporal we keep the
benefit without fighting the engine: a `GovernedWorkflow` contains **only a
fixed interpreter and a pure, sealed SAM machine**. Acceptors have no clock, no
I/O and no randomness by construction (the strict profile enforces a sealed
model and total next-state semantics). All agent work — model calls, tools,
Jev, humans — lives in activities. So:

- a non-determinism error in the machine is impossible by construction, not by
  discipline;
- the machine's state is small and separate from the context (transcripts,
  documents), which lives in external storage by content hash — the principled
  split between *control state* and *context state* that research/01 G6 says
  nobody has;
- versioning is a certificate hash mapped onto a Worker Deployment Version, and
  whether a running workflow may move to the new one is decided by polyvers
  over its snapshot, not by the absence of an NDE.

### 4.3 Where each component lands

| Plane | Component | Role on Temporal |
|---|---|---|
| Substrate | **SAM v2 strict** | the pure step function a `GovernedWorkflow` hosts; also the shape of G1 policy machines |
| Authoring | **polygen**, **polynv**, **polyness** | draft contract → machine → invariants; elicit invariants with the owner; propose workflows from the ledger |
| Verification | **polygraph** (check, check-effects, check-product) + polyaxion admission | admission certificate, signed, content-hashed; refused workflows cannot register on a worker |
| Versioning | **polyvers** | ramp gate on Worker Versioning: lanes over fleet snapshots pulled by Query; migration scaffold; decides PINNED vs AUTO_UPGRADE per run |
| Runtime | **Temporal** (primary), **polyrun** (standalone, reference) | durability, timers, retries, scale, HA — Temporal's |
| Agent contract | **polyflow** | the work-order inversion: an effect is an activity the agent completes asynchronously; the six MCP tools front a Temporal namespace |
| Coordination | **polycrew** | roles, claims, leases, humans as first-class principals — as workflow Updates |
| Policy | **polyaxion** kernel (one enforcement point) | G1 guard inside the outbound interceptor; witnesses; receipts |
| Judgement | **Jev** | calibrated typed observations (`noul`, `choice`, `score`) as an activity with assert/refute bands; the uncertain middle abstains and escalates, never guesses |
| Learning | **polyx**, polyness, the decision journal | mine rules from the ledger; suggestions only, promoted through G3 |
| Simulation | `polyrun simulate`, polysim | DST of governed workflows with stubbed agents; pass^k reports |
| Observability | polyviz, OTel exporter, polysmith | governance attributes on spans; deterministic diagrams; LangSmith bridge |

---

## 5. Requirements carried into the functional spec

Table stakes (must match Temporal's customers' expectations — research/01
§3.1): exactly-once effects; automatic recovery; zero-compute waits; large
payloads via claim-check; streaming; adapters for OpenAI Agents SDK, ADK,
LangGraph, Pydantic AI and MCP; safe deploys; multi-agent composition with
cancellation; OTel and cost accounting; operator controls; SSO/SCIM/RBAC;
tenancy; codec-compatible encryption; SOC 2 posture; HA; EU AI Act logging;
predictable pricing; Python and TypeScript first, Go and Java next.

Most of these are **inherited from Temporal** by being on Temporal. The spec
must say which ones are inherited, which we extend, and which we build.

Differentiators (build — the reason to acquire us):

| # | Capability | Ecosystem source | Literature / market gap |
|---|---|---|---|
| D1 | Admission certificate: nothing registers unverified | polygraph, polyflow gate | research/01 G2 |
| D2 | Effect guard with witnesses, budgets, trifecta, sequence rules | polyaxion, polycheck | G3; lit. #6, #7 |
| D3 | Governed workflows: machine decides what, agent decides how | polyflow, SAM v2 | G1; lit. #1, #3, #5 |
| D4 | Decision ledger: proposal → verdict → effect → observation, hash-chained, signed, replayable under another policy | polyaxion receipts, polyrun journal | G1, G3; Art. 12 |
| D5 | Fleet-gated versioning with verified migrations | polyvers | G4; W2 |
| D6 | Approvals bound to one action, consumed once; humans as principals with budgets | polycrew | G5; lit. #9, #10 |
| D7 | Calibrated judgement with abstention | Jev, polyx port | lit. #12 |
| D8 | Plans as proposals: agent-authored plans admitted at run time | polygen, polygraph | G2 |
| D9 | Learning loop: rules mined from the ledger, promoted only through D1 | polyx, polyness | lit. #13 |
| D10 | Control/context split: small machine state, content-addressed context | polyrun snapshot model | G6; W3 |
| D11 | Compliance evidence pack | all of the above | lit. #16 |

---

## 6. What the ecosystem must fix first

From the inventory (research/03 §6, §7, §9), before anything enterprise:

1. **One enforcement point.** Three `PreToolUse` gates exist (polyflow, polyaxion,
   polyx). The platform uses polyaxion's kernel; the others become inputs to it.
2. **One consequence vocabulary.** ACV 1.0 and polyaxion's label catalogue merge.
3. **A persisted, signed admission certificate** bound to the content hashes of
   all artefacts; today polyflow re-certifies in memory at every boot.
4. **polyvers wired to the runtime.** Today a changed workflow is simply
   re-certified; nothing checks it against runs in flight.
5. **Identity.** No component authenticates anyone. Principals, verified human
   provenance and tenancy are prerequisites for four-eyes rules and for any
   enterprise sale.
6. **Licensing.** Apache-2.0, BUSL-1.1, source-available commercial and
   unlicensed components coexist. An acquirer's diligence will read every
   `LICENSE`. The Temporal-facing packages are Apache-2.0 (Temporal's SDKs are
   MIT; Apache-2.0 is compatible and carries a patent grant); anything bundled
   into them must be too, or be an optional service behind an interface.
7. **Structured guards, not load-bearing names.** The enforcement point infers
   what to guard by parsing rule names; a `guards: <kind>` field replaces it.

---

## 7. What this platform does not do

- It does not replace Temporal, and it does not ship a durability engine to
  Temporal's customers.
- It does not make an agent correct. It makes the effects an agent can cause
  checkable against rules somebody wrote, over a declared finite domain.
- It does not prove anything about data outside the declared domains. Jev
  observations and finite abstractions narrow that gap; no gate measures it.
- It does not put a model on the decision path. Models interpret, propose and
  fulfil; engines decide. A probabilistic input is journaled data.
- It does not auto-promote mined rules. A mined rule is a suggestion until a
  person adjudicates it and the gate admits it.

---

## 8. Open questions for the specs

1. **Update vs activity completion for work orders.** Async activity completion
   (task token) is the native "parked handler". Updates give synchronous
   rejects with a reason. The technical spec picks one per interaction.
2. **Where the guard runs.** Inside the workflow outbound interceptor
   (deterministic, replay-safe, no network) vs a Nexus policy service
   (central, versioned, but a network hop per effect). Likely both: the kernel
   in-process, the catalogue and receipts central.
3. **TypeScript or Python first.** The OpenAI Agents SDK integration — Temporal's
   flagship agent story — is Python. The Poly stack is JavaScript. The SAM step
   function must run identically in both; the technical spec decides whether
   that is a port, a Wasm build or a subprocess. (Resolved in the technical
   spec §4: TypeScript first; the G0/G1 guard kernel is declarative and ported
   natively to Python; G2 machines run in Python through a hermetic evaluator,
   with a shared conformance corpus.)
4. **Pricing.** Per governed run vs per seat vs a Temporal Cloud add-on. The
   acquisition thesis argues for the add-on shape from day one.
