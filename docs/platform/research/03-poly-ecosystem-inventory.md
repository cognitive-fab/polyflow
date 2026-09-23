# 03 — The Poly ecosystem: an architecture-grade inventory

*Research note for the team building an enterprise durable-execution platform for AI agents (a Temporal alternative) on the Poly stack. Surveyed 2026-09-22 from the working copies under `C:\Users\jjdub\code\`. Code, specs and tests were read, not only READMEs. The polyflow and polycrew suites were run on this machine. Where a document and the code disagree, both are reported.*

> Read this the way the ecosystem asks to be read. Every check below is a **consistency check, not a proof**, and "exhaustive" always means exhaustive over the finite domains a contract declares. Status labels are *built*, *specified*, or *measured*. None of them means *production-proven*.

---

## 0. The one-paragraph picture

The ecosystem is one artifact family processed by many engines. A workflow is a **SAM v2 strict-profile state machine** (`machine.cjs` / `next.cjs`). It has a declared **contract** (`contract.json`: state keys, action alphabet, finite data domains, terminal states), **invariants** (`invariants.mjs`, and `effect-invariants.mjs` for emissions), a pure **effect mapper** (`effects.cjs`) and an **effect manifest** (`effects.manifest.json`: completion wiring and retry policy). Every engine reads or writes the same record, the **`{pre, action, data, post}` window**. The runtime journal is a stream of windows, so it is also a verification corpus. The engines sort into planes. polygen and polyness **author**. polygraph, polynv and the polyflow admission gate **verify**. polyvers **versions**. polyrun and polyflow **execute**. polycrew **coordinates**. polyaxion, polyman and polycheck **constrain**. polyness and polyx **learn**. Jev **judges** as a calibrated observation port. polysim **simulates**. polysmith and polyviz **export** and **observe**. The main architectural move sets it apart from Temporal: durability comes from **snapshots, not replay**. No determinism sandbox, no `patch()`. Versioning becomes a set of mechanical gates run over fleet snapshots.

---

## 1. At a glance

| Component | Plane | Version / state | License | Maturity (as read) |
|---|---|---|---|---|
| **polyflow** | runtime engine (single participant, MCP) | `@cognitive-fab/polyflow` 0.4.2, published | Apache-2.0 | Built. 48 tests, 47 pass here; the one failure is a CRLF checkout artifact (§3.1). 48-run model study with one harness and one model. |
| **polycrew** | multi-participant coordination | 0.0.1, not published; pins polyflow by tarball | Apache-2.0 | C0 built. 64/64 tests pass. Live acceptance run with 2 Claude Code sessions. C1–C3 are specified only. |
| **sam-pattern** | substrate | `@cognitive-fab/sam-pattern` 2.2.1 | ISC | Mature library (since 2016). The v2 strict profile is shipped, with 2.1 next-state semantics. |
| **polygraph** (audit) + **polygen** + **polyrun** + **polyvers** + **polynv** | verification, authoring, execution, versioning, invariant elicitation | `@cognitive-fab/polygraph` 8.3.0, one package | Apache-2.0 | Built, with self-tests per engine. A paper was submitted. The OMS worked examples cover all engines. |
| **polyviz** | observability (diagrams) | `@cognitive-fab/polyviz` 0.1.0, private workspace | (inherits the polygraph repo) | M1–M5 shipped, deterministic SVGs. |
| **polyness** | learning (mine a dev-agent's journal → a workflow proposal) | 0.0.1, private | Apache-2.0 | v0 built. Claims 164 tests. Recognition is measured and weak (1 right against 15). |
| **polyx** / **polyx-lens** | learning (rule mining with abstention, advisor) | polyx 0.1.1 / lens 0.2.1, published | polyx BUSL-1.1; lens Apache-2.0; Jev adapter MIT | MVP built and evaluated on ABCD, τ², BPIC and cc corpora. ABCD precision 0.53–0.58 is **BETWEEN** its falsification floor and its exit target. |
| **Jev** (typesafe.ai SystemOne) / **jev-lab** | judgement (calibrated System-1) | external API `jev-latest`; jev-lab is probe scripts | external / none | Measured, not integrated into the runtime. Integrated into polyx as an *annotation* port (spec rev. 1). |
| **polyaxion** (with **polysec** and **polyman** merged in) | policy / constraint plane, runtime enforcement, evidence | `@cognitive-fab/polyaxion` 0.1.0, private until launch | Files say Apache-2.0. Decided: source-available, $1000/yr per company. | Built. 100 + 892 + 36 tests. M2 and M3 proofs measured. The licence text is the launch blocker. |
| **polycheck** | policy (static least-privilege linter) + opt-in `guard` | `@cognitive-fab/polycheck` 0.7.0 | Apache-2.0 | Built, zero dependencies, published. |
| **polysim** (+ **polysim-cloud**) | simulation (DES over verified machines) | 1.0.6, private; cloud is AWS CDK | No licence file; private | Engine built. Most worlds are scientific or financial rather than agent workflows. Changing the engine requires explicit approval (commit-hook enforced). |
| **polysmith** | export (LangSmith/LangGraph adapters) | spec + plan only | none | **Designed, not built.** No code. |
| **polygents** (+ **polygent-cloud**) | judgement products (mandate → interpret → judge) | 0.1.0, private | Commercial, $1000/org/yr; cloud UNLICENSED | Local tier built (Formulator, Reviewer, Guard, `gate`). The oracle runs on AWS. |
| **polyjit** | evidence base (constraint survival) | research repo | MIT | Measured (1.7% survival through generation; 0% after 2 compactions). |
| **polygraph-control-plane** ("polygate") | CI merge gate | docs + GitLab mock | Apache-2.0 | Demonstrated on a mock GitLab CE. |
| `polyman` (top-level dir) | — | **does not exist** | — | Lives in `polysec/polyman` and `polyaxion/packages/polysec/polyman`. |

---

## 2. The common substrate

### 2.1 SAM v2 and its strict profile

`@cognitive-fab/sam-pattern` implements the SAM pattern, which is based on TLA+ semantics. One synchronized step:

```
Action ─proposal─▶ | Acceptor(s) → Reactor(s) | ─▶ Next-Action-Predicate (NAP) and/or Render(state)
```

- **Actions** compute a *proposal* from an event. They are converted to named *intents*.
- **Acceptors** are units of mutation. They accept, partially accept or reject the proposal.
- **Reactors** are invariant mutations: functions of state, independent of the proposal.
- **NAPs** fire after the step. They may present a new action ("automatic" next steps, side effects), and they may suppress rendering.
- **Render** publishes the state representation.

(The platform brief says "propose/accept/learn". That phrase appears only in this project's own literature note, `02-agentic-ai-literature.md`. The library's own terms are action/proposal → acceptor → reactor → NAP/render.)

The **strict profile** (`createInstance({ strict: true })`, v2.0–2.2) turns SAM conventions into enforced construction so that a module is mechanically checkable:

| Obligation | Mechanism | Error |
|---|---|---|
| Named intents with payload **schemas** (#20) | a proposal missing a required field throws on first fire | `SamSchemaError` |
| Declared, **sealed `modelShape`** (#21) = TLA+ `VARIABLES` | writing an undeclared key throws; `getState()/setState()` round-trip totally | `SamShapeError` |
| First-class **`reject(reason)`** (#22) | every no-op step is classified `rejected \| unhandled \| identity-by-mutation` via `lastStep()` | — |
| **Per-action acceptor registration** (#23) | `acceptors: { ACTION: model => (proposal, api) => … }`; `'*'` for cross-cutting | — |
| Per-intent **finite input domains** (#24) = TLA+ `CONSTANTS` | the checker explores declared domains with no harness configuration; `validate()` fails without them | — |
| **Next-state (prime) semantics** (#25, v2.1) | `model` is the frozen pre-state; writes go to `next`; every variable must be assigned or named via `unchanged(...)`; a double-prime throws; async acceptors throw unless `synchronize: true` | `SamFrameError` |
| Reject-after-write in the same acceptor (#36, v2.2) | throws; a *different* acceptor vetoing is still legal | `SamFrameError` |

`manifest()` exposes intents, schemas, domains, `modelShape` and per-acceptor prime/frame sets, so external tools such as the explorer and the TLA+ transpiler never parse code.

**How the stack uses SAM.** polyrun machines and polyflow workflows use **no reactors and no NAPs** (`reactors: []`). The NAP role — deciding what side effect follows a step — is taken out of the module and given to the pure **effect mapper** `effects(pre, action, data, post, stepKind) → intents[]`. That keeps the module a pure transition relation and lets the emission checker explore machine ∘ mapper. polysec's design keeps the NAP as a concept ("prevention in the acceptor, correction in the nap", doctrine 1). A platform team should treat "NAP = effect mapper + work order" as the working mapping.

### 2.2 The artifact family (`polygraph/docs/ARCHITECTURE.md`)

| Artifact | Content | Produced by → consumed by |
|---|---|---|
| `contract.json` | `stateKeys[]` (the first key is the primary control state), `initState`, `actions{NAME:{dataFields}}`, `dataDomain{ACTION:{field:[values]}}`, `terminalStates[]` / `terminalKey`, `specialRules[{name,note,whenState,whenAction}]`, `noOpRule`; schema at `polygraph/templates/contract.schema.json` | human / polygen / polyness → every engine |
| `machine.cjs` / `next.cjs` | a SAM v2 strict module exporting `{instance, init, actions, getState, setState}` (`--legacy-bare-next` still accepts a bare `next(state, action, data)`) | polygen / LLM spec generation → replay, checker, polyrun, polysim, polyaxion compiler output |
| `invariants.mjs` | `{ stateInvariants:[{name,pred(state)}], transitionInvariants:[{name,pred(pre,action,data,post)}] }` | human (polygen/polynv propose) → checker, deploy gate, polyvers, polysim monitors |
| `effects.cjs` | pure mapper → `{kind, payload}`, `{kind:'timer', key, fireIn/fireInMs/fireAt, action, data}`, `{kind:'cancelTimer'}`, `{kind:'spawnChild', machineId, childKey, initData, onComplete}`, `{kind:'signalChild'}` | polygen draft + human review → kernel, check-effects |
| `effects.manifest.json` | per kind: `payloadSchema`, `onSuccess`, `onFailure`, `onExhausted{action,data}`, `retry{maxAttempts,baseMs,timeoutMs}` | → kernel workers, cross-checks, polyvers vocabulary lane |
| `effect-invariants.mjs` | `effectInvariants:[{name, pred(path)}]` over **emission paths**: `path.emitted[{kind,step}]`, `path.actions[{action}]`, `path.count(kind)`, `path.actionBefore(action, i)` | → `polyrun check-effects`, polyflow admission |
| `invariants.compose.mjs` | `{stateInvariants:[pred(joint)], transitionInvariants:[pred(preJoint, stimulus, postJoint)]}` with `joint = {parent, children{childKey:{state,status,…}}}` | → `check-product`, `polyvers product`, polysim |
| `migrate.cjs` | pure `migrate(oldState) → newState` | polyvers scaffold + human → migrate gate, `polyrun migrate` |
| traces `*.ndjson` | `{pre, action, data, post}` windows | instrumentation / **polyrun journal** → replay, audit, polynv mining |
| `compat-report.{json,md}` | lanes fired, gates run, corpus provenance tier, invariant-adequacy tier, one witness per violated rule | polyvers → CI |
| `intent-ledger.json` | append-only record of every candidate invariant, with dispositions, authors and adequacy grade | polynv |
| `polyflow.workflow.json` | polyflow's descriptor (§3.1) | author / polyness → polyflow, polycrew |

State equality everywhere is `stable()`, a key-order-insensitive canonical stringify (`scripts/load-spec.mjs`). There is one definition, and every consumer shares it.

---

## 3. Component inventories

### 3.1 polyflow — the single-participant engine (`C:\Users\jjdub\code\polyflow`)

**Purpose.** An MCP stdio server that lets an agent run a *verified* state machine instead of choosing one tool call at a time. It admits a workflow only if every reachable emission path satisfies its effect invariants. Then it hands the agent **one work order at a time** and keeps run state in SQLite, outside the conversation. The inversion that defines it: *polyflow executes nothing*. It holds no credentials and no connectors. Every effect becomes a work order the agent performs with its own tools and permissions, then reports.

**Code (≈1,450 LoC, `src/`).**
- `daemon.mjs` — `Polyflow`: `start()` (the admission gate and runtime creation), `begin(workflow, key, input)`, `view`, `settle`, `report`, `dispatch`, `runs`, `timers`, `journal`, `traces`, `close`. It embeds **polyrun** in-process (`createRuntime({store:{sqlite}, machines, handlers, worker:{leaseMs}})`).
- `library.mjs` — `Library` (procedural memory: a directory of workflows), `deriveKey`, `certify()`. `certify` calls `checkEffects({module, mapper, manifest, invariants, contract, maxDepth:12, maxPaths:50_000})`, and **a BOUNDED result is a refusal**. `machineSpec()` supplies the polyrun machine entry.
- `broker.mjs` — the in-memory `Broker`. Each polyrun effect handler **parks** a promise, heartbeats `ctx.extendLease`, and resolves or rejects on `report`. The **broker contract** is documented as six methods and six obligations (below).
- `tools.mjs` — `makeTools(pf, extra)`: the six MCP tools, with output schemas in a "plain subset" (no unions, no `$ref`, no `required`) and read/write annotations.
- `areas.mjs` — the two-tier address. The instance id is `agent|instance|workflow|key`, and it is **derived**, which is why start and attach are one call.
- `mcp.mjs` — a hand-rolled JSON-RPC 2.0 stdio server (protocol `2025-06-18`), with no dependency.
- `match.mjs` + `decisions.mjs` + `adapters/claude-code/gate.mjs` — the **enforcement point** (step 4b). A `PreToolUse` hook denies a *guarded* effect (one that has a `match` and is named by an admitted invariant) when no running instance has an open order for it. Matching is an argv prefix. It is narrowly fail-closed: an unreachable order book denies only guarded effects. Each decision appends a line to `.polyness/decisions.jsonl` (`allow | deny | deny+overridden`, with secret redaction). The in-process decision takes ≈17.7 µs; a command-hook spawn costs ≈940 ms.
- `polyrun.mjs` — resolves polyrun from `@cognitive-fab/polygraph` (^8.1), a sibling checkout, or `POLYFLOW_POLYRUN`. An override with no build behind it is an error.

**Data model.**
- *A workflow is six files:* `polyflow.workflow.json` (`name`, `description`, `area`, `inputAction` (default `START`), `tools{effectKind → {tool, target?, why, match?, role?}}`, `key{template:"{date}", fields:{date:{pattern, description}}}`), `contract.json`, `machine.cjs`, `effects.cjs`, `effects.manifest.json`, `effect-invariants.mjs`, plus an optional `invariants.mjs`.
- *Store:* polyrun's SQLite tables, `pr_instance` (state snapshot, status `active|terminal|poisoned`, seq, `machine_version`, parent/child columns), `pr_journal` (`global_seq, instance_id, machine_version, seq, action, data, pre, post, step_kind, reject_reason, action_id, at`; PK `(instance_id, seq)`, UNIQUE `(instance_id, action_id)`), `pr_outbox` (intent leases, attempts, status `pending|inflight|done|dead`) and `pr_timer`.
- *Work order* (the MCP shape): `{order_id (= polyrun intent id), tool, target?, args, why, attempt, role?, claimed_by?, claimed_until?}`.
- *Action ids* in the journal: `$create`, `<order_id>:done`, `timer:<id>`, `child:<instance>:complete`.

**Tool surface (6).** `workflow_list` (catalog, with `admitted` and `guarantees` = invariant names), `workflow_start` (start **or re-attach**; the key is derived from validated input, a caller key is ignored with a note, and a terminal run returns `already_complete` plus "do NOT start another run"), `workflow_report` (`ok`, `permanent`; a permanent failure is a *result* that dispatches `onFailure`, and a non-permanent one retries), `workflow_state` (a pure read), `workflow_signal` (an out-of-band action; a non-applicable one is an observable reject, returned with `step_kind`, `step_seq`, `reason`), and `workflow_journal` (every step with its reason; also a valid Polygraph trace corpus). The CLI and installer, `polyflow-install`, write configuration for OpenWorker, Kiro, Hermes, Claude Code, DeepSeek Harness, NeMo NAT and AWS Agent Registry. Only the OpenWorker path has been run end to end.

**The broker contract** (the seam polycrew replaces): `handler(kind, spec)`, `open(instanceId, {sweep:false})`, `orderById`, `issued`, `report(orderId, result)`, `abort(reason)`. The obligations are: keep the worker lease alive while parked; `orderById` must return `instanceId`; `open` must be a pure read and carry `role/claimedBy/claimedUntil`; `report` and `abort` are awaited; `report` resolves an object; `report` may answer `{ok:true, deferred:true}` when it recorded a result with nothing parked to receive it. A broker has exactly one owning `Polyflow`.

**Durability semantics.** The parked promise is in memory. On a crash the lease expires, polyrun re-claims the effect and the order is re-offered with the same intent id and a higher `attempt`. That gives at-least-once delivery; completion dispatch is deduped by `<intentId>:done`, and stale or duplicate completions are the machine's observable rejects.

**Evidence.** In `FINDINGS-phase3.md` (48 runs, deepseek-v4-flash, OpenWorker's own engine), a double-fired scheduled job posted twice **8/8** without polyflow and 1/8 with it. After **derived keys** it posted twice 0/8. No run in any condition posted without approval (48/48). The document states plainly that the invariant was not the differentiator on a single run.

**Test status on this machine.** 47 of 48 pass. `enforcement-point.test.mjs › a workflow refused at admission guards nothing` fails because the test patches `machine.cjs` by matching `\n`-terminated text, and this Windows checkout has CRLF endings (`file` reports CRLF). It is a line-ending artifact, not a logic failure; add `.gitattributes` `eol=lf`, as polygraph did.

**Not built (README):** promotion from journals (now polyness), polyvers wiring, `polyrun audit` wiring, signed journals (hash chain + signature, Dapr 1.18-style), and the MA-11 timer-on-wait and MA-13 product checks in the gate.

**Platform fit.** polyflow is the **agent-facing runtime API** and the template for the platform's "worker = agent" model. Keep the work-order inversion, derived identity, admission-before-registration and the six-tool surface. Replace the stdio-per-session deployment and the in-memory broker (the polycrew seam exists for exactly this). Postgres is already in polyrun.

### 3.2 polycrew — multi-participant coordination (`C:\Users\jjdub\code\polycrew`)

**Purpose.** Several agents and people work one run at once. "Agents never talk to each other; they talk to the run." It uses polyflow as a library: it supplies a **store-backed broker** and **extra tools**, and uses `Library` and `Polyflow` unchanged. It never forks the admission gate ("two gates would mean the guarantee stops being one sentence").

**Code (≈1,400 LoC).** `store-broker.mjs` (the `pf_orders` SQLite table: `order_id, instance_id, kind, tool, target, args, why, role, attempt, status (open|claimed|reported|done|…), claimed_by, claimed_until, result_json, result_ok, result_error, result_permanent, reported_by, reported_at`), `link.mjs` (the **election**: the first process to bind the crew's derived loopback port is the broker, the rest proxy; if the broker dies the next call re-elects), `node.mjs`, `registry.mjs` (`~/.polyflow/registry/<crew>/`, pid-reaped), `attribution.mjs` (who caused each step, joined onto the journal *on read* because polyrun's journal has no actor column yet), `crew-tools.mjs`, `dashboard.mjs` (`/dashboard`, `/dashboard.json`, loopback-only, GET-only).

**Tool surface (8).** The six polyflow tools plus `workflow_next` (open, unclaimed orders the session's roles allow, across the crew) and `workflow_claim` (a lease; a refusal is the *answer* `claimed:false` with the holder, not an error). Only the holder may report (`not-your-order`). A late report with nobody re-claiming is accepted. A report with a dead broker is **recorded, not lost** (`deferred`). **Identity and roles come from the process** (a minted `actor` id and `POLYCREW_ROLES`), never from a tool argument.

**Specified but not built** (`docs/polycrew-spec.html`, draft 4, MA-1…MA-22): capability binding per host (`capability` → a host-profile tool name), human actors with `asserted`/`verified` provenance, `workflow_attach`, `workflow_progress`, `workflow_report_run` (a deterministic, hash-stamped run report), child fan-out with derived child keys, join-as-acceptor with **a mandatory timer on every waiting state**, the parent×child product check in admission, host wake events over journal fan-out, and `actor/order_id/provenance` columns on `pr_journal`.

**POLYAXION-INTEGRATION.md (draft, not built).** A claimed order becomes a polyaxion session: scope `polycrew/<workflow>/<role>`, session `<instanceId>::<orderId>`. The order's declared effects are its authority ("excess voids"). Run-scoped monotone vars carry taint across orders. There is **one receipt chain per run**, and report-time **reconciliation** of reported against executed effects (`corroborated | uncorroborated | unmediated`). The coordination tools themselves are not gated (doctrine 28).

**Maturity.** C0 is complete: 64/64 tests pass here, and there is a live two-session acceptance run (4 orders, 4 completions, 2 minted actors, no duplicates). Stated limits: **no authentication at all** (loopback trust), SQLite with a single elected writer, and one machine.

**Platform fit.** The coordination semantics carry over directly: claims as leases, role-addressed orders, derived identity, "refusal is an answer", and joins as verified acceptors plus timers. The deployment model (port election, loopback, no auth) is a prototype. An enterprise platform needs a real broker service, authenticated principals (the same gap as polyaxion CR-016) and multi-tenant stores.

### 3.3 polygraph (audit), polygen, polyrun, polyvers, polynv, polyviz (`C:\Users\jjdub\code\polygraph`)

One npm package, `@cognitive-fab/polygraph` 8.3.0, Apache-2.0, published 2026-09. It ships as a Claude Code plugin (skills, commands and agents for `verify`, `polygen`, `polyvers`, `polynv`, `workflow`) and as CLIs.

**Polygraph (audit).** An LLM generates N independent specs from source code in any language (a Go OMS was audited through Temporal's own test suite). Real traces are **replayed** against every spec. Controls come first: a hand-written reference must replay 100% and a mutant must fail. Disagreements are triaged into *spec-error / code-finding / contract-error*. Then the specs are **model-checked** (BFS from `init()` over declared domains, `scripts/check.mjs`) against `invariants.mjs`, producing shortest counterexamples. There is an optional TLA+/TLC tier (`scripts/to-tla.mjs`). Doctrine: *replay finds unfaithfulness; the model check finds bugs.*

**polygen (authoring).** `node scripts/polygen.mjs --intent "<feature>"` runs six gated stages: contract draft, SAM v2 module, strict `validate()`, the DEAD-AT-INIT check, proposed invariants, the model check, **self-repair (code only, never invariants)**, contract/code domain cross-checks, and a synthesized trace corpus with independent replay. It reuses the audit core ("cannot grade its own homework with a softer ruler"). A non-converged run is reported as NOT converged. The output is "capture-ready by construction" (CR-1…CR-8, e.g. inject non-determinism, declare effects and execute them at the edge). The `workflow` command runs a "workflows, not loops" recipe end to end.

**polyrun (durable execution; the engine polyflow embeds).** `docs/polyrun-spec.md` defines FR-1…FR-8. Implementation: `polyrun/src/*` ≈3,900 LoC.
- **One write path.** `dispatch(instanceId, action, data, actionId)` is **one ACID transaction**: row lock, dedupe check, rehydrate (`setState`), fire, classify (`lastStep`), then commit snapshot + journal row + outbox intents + timers + dedupe together. Dedupe is `(instanceId, actionId)`.
- **Effects.** A transactional outbox. The idempotency key is `hash(instanceId, seq, kind, ordinal)`. Emission is exactly-once and execution at-least-once. Completions arrive as `<key>:done`. Retry uses backoff, a DLQ and `onExhausted` (the *machine* decides what "provider down" means). Long-running work should use request/callback; lease extension is a second-class escape hatch.
- **Timers.** Timers are intents. Staleness is handled by the machine's observable reject rather than by cancellation races.
- **Children (FR-8).** `spawnChild` / `signalChild`. Completion actions are deduped by child id. A terminal parent cancels its children via a declared action. The whole cascade runs inside the parent's transaction (max depth 8).
- **Poison doctrine.** Anything "impossible" for a verified module (a throw mid-step, mutate-then-reject, an undeclared effect) durably quarantines the instance. A caller's bad payload is only a reject.
- **Stores.** SQLite (`node:sqlite`, WAL) and Postgres (`FOR UPDATE`, `SKIP LOCKED`, jsonb/GIN). The whole suite runs against both. Measured ≈1,200 steps/s on SQLite and ≈990 on Postgres, p99 ≈20 ms.
- **CLIs / binaries.** `polyrun deploy` (a gate: strict-clean, snapshot round-trip, model check **seeded from live snapshots**), `check-effects`, `check-product`, `simulate` (seeded DST against the real kernel with the model in lockstep), `audit` (replay of the production journal, version-aware), `migrate` (two-phase, seq-fenced, journaled as a `$migrate` row), `archive`, `export-traces`, `dlq ls|retry|discard`. Also `polyrun-worker` (stateless workers) and `polyrun-api` (an HTTP facade on loopback with a read-only UI).
- **Temporal comparison (spec §9).** polyrun wins on logic verification, versioning and ops footprint (one Postgres). It loses on scale (one Postgres; sharding is future work), languages (JS only), heartbeating activities, ecosystem maturity and the literal replay of an old decision procedure.

**polyvers (versioning).** `polyvers classify|check|migrate scaffold|matrix|product`. It diffs two artifact directories into **lanes**, and each lane demands gates:

| Lane | Fires when | Gates |
|---|---|---|
| semantic | the module changed | load · shape-roundtrip · invariants-pointwise · **semantic-model-check seeded with fleet snapshots** |
| shape | contract `stateKeys` changed | load · migrate · shape-roundtrip |
| migration | `migrate.cjs` added or edited | load · migrate · shape-roundtrip |
| vocabulary | actions / reject reasons / effect kinds / terminal states changed | load · vocabulary · stimuli (every old stimulus lands as accepted or a *named* reject) |
| intent | `invariants.mjs` changed | invariant-diff · pointwise · seeded model check |
| composition | `effects.cjs` changed | load, plus NOT RUN rows pointing to `check-effects`, `matrix`, `product` |

**Corpus provenance is part of the verdict.** `--snapshots` (fleet exports from `polyrun archive`) is the honest tier. `--synthesize` (BFS states of the old model) is the weakest tier and is disclosed as such. An empty corpus is refused. `matrix` checks the parent {old,new} × child {old,new} delivery protocol; `product` runs the joint-state check per pairing. Doctrines: *deprecate, don't delete*; reject-reason strings are public API; a strengthened invariant is a fleet event. The definition being mechanized: *v(n+1) is compatible iff no live v(n) state can be driven to an invariant violation under v(n+1) over the declared domains.* Still open: joint mid-flight seeding, and grandchildren (refused, not certified).

**polynv (invariant elicitation).** `harvest` (contract templates, state-property and precedence mining over traces and journals, frontier-model domain priors, each candidate **pre-checked** to arrive as "HOLDS: rule or coincidence?" or "counterexample: acceptable?"), `questions`, `record --disposition confirm|reject|abandon|defer|modify --author` (append-only `intent-ledger.json`), `grade` (mutation adequacy over four operator families, with equivalent mutants discarded by graph comparison; OMS hand-written invariants kill 101/113), `drift` and `report`. "Harvested candidates are behavior, not intent." The grade flows into polyvers reports as a trust tier (measured / STALE / UNREADABLE / NOT MEASURED).

**composition-semantics.md.** The soundness anchor. Because cascades are atomic and dispatch is single-writer per instance, any fleet execution equals a sequence of atomic cascade closures, one per top-level stimulus. The only nondeterminism is which stimulus lands next, and that is what makes the product check tractable. CP-M2 adds child abstraction and PCT sampling; partial-order reduction was dropped.

**polyviz.** A deterministic SVG catalog (state-machine via elkjs, invariants, counterexample bug and fix, compat-gate, model-card) from a viz-model JSON or an artifacts directory. Byte-identical output, no model at render time, `polyviz report` injection into Markdown.

**Platform fit.** This package *is* the verification/admission, versioning and core runtime planes. polyrun is the durable kernel, and polyvers is the deploy gate for workflow versions against in-flight runs, which Temporal lacks. The team should treat `polyrun/src/kernel.mjs` + `store*.mjs` as the kernel to harden. NFR-3 (a kernel of about 500 LoC reviewable in one sitting) is the stated trust argument.

### 3.4 polyness — learning from a dev agent's journal (`C:\Users\jjdub\code\polyness`)

**Purpose.** The induction half of polyflow: "the workflow to propose is the one you already run, and the rule to enforce is the one you already break." It reads Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) and normalizes them to an **alphabet**: `Bash` becomes its command head (`git push`, `npm test`), and `cd … &&` hops and env prefixes are stripped. It splits sessions into **episodes** (user prompt to user prompt) and mines rules over **consequential events, not sequences**. Sequence mining found a shape in 3% of projects; event mining found something in 22%.

**Rule vocabulary** (maps 1:1 onto polyflow effect invariants): `at-most-one-<C>-per-run`, `no-<C>-without-a-prior-<V>`, `<C>-implies-a-prior-<S>`, `exactly-one-<S>-when-started`. **Provenance:** *own* (≥60% support in this project, proposed with its exceptions listed), *borrowed* (holds in ≥3 other projects, shown only on request), *neither* (never proposed, but replayable). The support floor is 5 instances. Each rule carries the date it was mined, so it can go stale and be retired.

**Surface.** CLI `polyness audit [--show|--correct]`, `replay <rule>`, `propose <subject>`. `propose` writes `.polyness/proposals/<name>/{contract.json, effect-invariants.mjs, polyflow.workflow.json, NOTES.md}` and does **not** write the machine; polygen authors it and polyflow admits it. The MCP tool `workflow_suggest` handles recognition and prints without acting. State lives in `.polyness/{corrections.json, shapes.sqlite, proposals/, decisions.jsonl}`.

**Maturity.** 164 tests (claimed). Private 0.0.1, Apache-2.0. Recognition is weak and says so (1 right against 15). Only the Claude Code reader exists. Its spec says the second corpus should be **polyflow's own journal**, which is host-neutral and already in window format.

**Platform fit.** The learning plane's **workflow-induction** path: journals → proposal → polygen → admission. The decision journal (`deny+overridden` = a labelled false positive) is the feedback signal for retiring rules.

### 3.5 polyx and polyx-lens — rule mining with abstention (`C:\Users\jjdub\code\polyx`, `…\polyx-lens`)

**Purpose.** polyx is the commercial generalization of polyness to any agent whose decisions are **typed actions with a declared consequence**, such as CRM agents, loan origination and coding agents. It mines rules the agent's own history supports and **serves them back with abstention**. polyx-lens (Apache-2.0) is the free front half: the canonical record, alphabets, ingest adapters (Claude Code, ABCD, τ²-bench, BPIC 2017, synthetic), ports and a compliance "lens" that reports which *given* rules were kept, and leads with the unknown rate.

**Key formats.**
- *Canonical record* (TS §3): `Interaction{id, corpus, actor{agentId?, teamId?, operatorId}, events[], outcome?}`. `Event{seq, at, episode, kind: customer_intent|customer_utterance|agent_utterance|action|system|unknown, type ('action:issue_refund'), slots, result, raw: {file, path}}`. `raw` is a pointer, never a copy; `unknown` is counted, never dropped.
- *Alphabet* (`alphabet.<corpus>.yaml`, versioned) with **ACV 1.0** consequence ordinals: `none | reversible | compensable | irreversible`, plus `recommendable`, `verifies`, `binds`, `actor`. See `docs/acv-1.0-spec.md`.
- *Rule* (TS §7.1): `{id = hash(family, pattern, bindings, conditions, window), family: obligation|recommendation, pattern, bindings, conditions?, window: episode|interaction, support{holds,of}, counterexamples, provenance, status: proposed|real|not_real|narrowed|retired|refused|suppressed|contradicted, scope, alphabetVersion, minedAt}`. The patterns are Declare-style (`precedence`, `absence2`, co-existence), plus a same-slot identity pattern (rev. 13). Provenance is a lattice: operator → team → agent → borrowed → neither, with **warrant** (mined vs asserted) as an orthogonal axis (designed, not built).
- *Advisor* `POST /advise {operator, agent, episode.events, facts, considering, contact?}` returns `recommend | warn | abstain{uncovered|unknown_fact, missing[]} | clear`. It uses **three-valued logic**, prohibits the closed-world assumption, serves only rules adjudicated `real`, and targets p95 < 50 ms at 500 rules.

**Standing rules.** No LLM in the mining path (the same inputs give an identical rule set). Nothing is served without human adjudication. A `check:boundary` script enforces the import boundaries.

**Maturity.** MVP built and measured. ABCD precision 0.529 strict / 0.575 lenient, recall 0.497, refusal correctness 1.000. That sits BETWEEN the falsification floor (0.4) and the exit target (0.70). The reviewer surface median was 8.4 s per rule (the rater wrote the alphabet). There is an example `PreToolUse` hook (`examples/claude-code-hook/`).

**Platform fit.** The learning plane's **rule-mining and advisory** path for workflows whose steps are consequential typed actions. The advisor is a decision-point service a workflow can call as an effect, or a gate can consult. polyx-lens is the ingest and normalization layer for foreign agent logs.

### 3.6 Jev — the calibrated System-1 judge (`C:\Users\jjdub\code\jev-lab`)

**What it is.** typesafe.ai's "SystemOne" HTTP API. `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`, body `{state: <text>, model: "jev-latest", questions: {name: question}}`. Question types:
- `noul` — `{type:'noul', instructions, criteria?:{true,false}}` → a probability `answers[name].noul ∈ [0,1]`
- `choice` — `{type:'choice', instructions, criteria:{label: description}}` → `{choice, confidence}`
- `score` — `{type:'score', instructions, criteria:[levels]}` → an ordinal `score`

The response carries `usage`. It emits **no text, ever**.

**Measured (jev-lab, 2026-09-19, 45 calls).** p50 208 ms. Latency is flat in question count (8 questions take 164 ms), so batch the whole predicate set in one call. The quantum is 0.01 and **jitter is ±0.01, so it is not bit-stable**. `choice` silently drops secondary intents on multi-intent input, while a battery of `noul` questions recovers them; polyx therefore prohibits `choice`. jev-lab's `seams.py` probed four seams: polyflow branch routing with a confidence gate, polyaxion red-line/obligation/mandate guards, polysim stability, and polygraph/polyx. `poc/run.mjs` compares Jev against the real polyx `Advisor`.

**Integration as specified (polyx-jev-integration-spec, rev. 1).** Jev is an **observation port**: `(text, declared predicate) → Scalar fact, or nothing`. Predicates are declared and reviewed artifacts (`predicates.<corpus>.yaml`, `obs.<name>` facts, `assertAt`/`refuteAt` bands, calibration records). Below the assertion band it emits **nothing, never false**, so the advisor abstains `unknown_fact`. Because of the jitter, annotation is a **separate frozen pass** (`polyx annotate`), digested and pinned in the manifest, and mining reads recorded answers. That is doctrine 22 in action: *probabilistic inputs are journaled data, not live calls*. Text is redacted before it leaves the machine. polygents has also put Jev behind the Guard's labeler as a "graded vote".

**Platform fit.** The judgement plane. It turns text-dependent guards (was consent given, is this within mandate, which branch) into *facts* a verified machine or gate can consume. For replayable durable execution, a Jev call must be an **effect whose result is journaled** as action data, never a call made inside an acceptor.

### 3.7 polyaxion (with polysec and polyman) — the constraint plane (`C:\Users\jjdub\code\polyaxion`)

**Purpose.** "Obligations declared once as predicates and state machines, living outside the context window, enforced by a deterministic guarded merge before any effect executes." It is a mount (Claude Code hooks + MCP, SDK adapters, NVIDIA NAT), not a harness. polysec (the proof pipeline) and polyman (the kernel) were merged in with history on 2026-09-01. The standalone `C:\Users\jjdub\code\polysec` is the older enterprise-edition checkout.

**Policy format** (`polyaxion.policy.json`): `{polyaxion:"1", id, scope (glob), budget?, obligations[]}`. There are five obligation kinds:
- `rule` — PX `when` / `require`, severity `deny|warn|escalate`, `hint`, `examples{deny,allow}`
- `machine` — states, finite vars, gate-phase and settle-phase transitions, guards, discharge `end` states
- `invariant`
- `recalled` — prose that is re-injected, not gated, and said so
- `native` — a hand-written polysec triple, run as a sibling kernel

**PX** is a small total expression language with three-valued logic and history functions (`count(history, …)`, `glob`). An unknown value never satisfies a requirement.

**Pipeline.** The compiler turns a policy into polysec's **policy triple**: `next.cjs` (SAM v2 strict, whose acceptors evaluate PX), `contract.json`, `security.json` (forbidden regions, gates, tools, capabilities) and `invariants.mjs`. **Admission** runs `harden` (six conjuncts, "fully mediated"), the polygraph exhaustive check, the examples, per-machine dischargeability (mandate m2), the computed worst case per call against the budget, and the hidden-context lint. An unservable policy is stored and **never served**. Replacing a policy under live sessions runs **polyvers lanes over live Σ**, and a breaking change is refused unless migrated.

**Runtime.** The verbs are `declare, merge, settle, recall, endCheck, end, escalated, journal, census, verify, replay, sign, token`. A tool call is extracted into canonical actions (one per chained shell command) and labeled from a **signed label catalogue** with effect classes, reversibility, sensitive and untrusted. Native kernels run first, then the scope composite; *red dominates green*. The result is allow, **deny with a witness** (obligation, failing expression, bindings, violating prior steps, machine path), or `escalate` (a human lift must name the recorded escalation). PostToolUse settles observed results, taint grows, and settle-phase transitions fire only on verified success. **Recall** re-injects active obligations after every compaction. The composite merge takes 0.63 ms p50 and ≈4 ms per hook round trip. One gate process runs per store, **elected by binding a loopback port**, the same idiom as polycrew.

**Evidence.** Append-only SQLite windows. One **ed25519 notary receipt per window, chained per session**, binding the window, policy and verdict digests. `verify` runs five checks, including **replay that re-derives every decision**.

**Proofs.** M2: 100% obligation survival through five compaction rounds (against 52.8% → 10.1% without the gate), 51/51 violating sequences denied, 45/45 compliant allowed. M3: four executors from three vendors, 0 violations in 180 mounted sessions. AGCP self-assessment covers 122 requirements.

**polyman** is a taint-tracking reference monitor for the lethal trifecta. Its policy is model-checked "FULLY MEDIATED" before shipping, and a byte-parity test shows the enforced machine equals the proven one. Adapters exist for the Vercel AI SDK and Agent SDK, plus `wrapMcp`.

**Doctrine registry** (`packages/polysec/docs/polysec-system-spec.md` §6, 29 doctrines, cited by number). Among them: 1 prevention in the acceptor, correction in the nap · 2 fully-mediated over unreachable · 3 default-deny · 8 a reject names its misfire · 10 approvals are answers, bound and consumed · 12 canonical or unsignable · 13 a receipt binds its proof · 20 verify at design time, monitor at runtime · 21 hand the human a bundle, not a score · **22 probabilistic inputs are journaled data, not live calls** · 23 a filter reduces frequency, not possibility · **24 absent evidence is unobserved, never clean** · **26 excess voids, missing never fails** · 27 a record must detect its own tampering · **28 a control-plane failure may block new things, never stop running things** · **29 red dominates green**.

**Maturity and licence.** Built. 100 polyaxion tests, 892 polysec, 36 polyman, and a static test that the decision path calls no model. Private until launch. The decided licence is **one product, source-available, $1000/year per company**; the files still say Apache-2.0. Open decisions: subagent delegation and forced end without discharge.

**Platform fit.** The policy plane's **runtime enforcement point** for effects an agent executes. In a work-order architecture this is the gate between the agent and *its own tools*. It is also the most mature **evidence and receipt** design in the ecosystem (signed chains, replay-verify), which polyflow lists as "not built".

### 3.8 polycheck — static least-privilege linter (`C:\Users\jjdub\code\polycheck`)

**Purpose.** It reads `.claude` settings and MCP config and deterministically outputs either **PROOF** (every path into a forbidden region crosses a gate) or **WITNESS** (a concrete sequence of allowed calls reaching credential egress with zero gates, optionally drawn with `--mermaid`). It has zero dependencies, runs offline with no model or clock, and ships as `npx @cognitive-fab/polycheck .` (0.7.0, Apache-2.0). An opt-in `polycheck guard` runtime layer "gates the call which completes a composition". The authors published a negative field result: models refused the attack, which they present as "a good screen and a bad control". It is "never better than its labeler".

**Platform fit.** The **deploy-time** half of the policy plane: lint an agent's tool surface before a workflow's work orders are routed to it. polygents' Guard wraps it.

### 3.9 polysim (and polysim-cloud) — simulation (`C:\Users\jjdub\code\polysim`)

**Purpose.** "The sixth engine": deterministic discrete-event simulation of **fleets of verified SAM v2 machines** under a **virtual clock**. It runs the *same* artifacts as polyrun, **unchanged** ("one policy, one codebase"). There are five layers: L1 machines · L2 kernel (polyrun's dispatch ladder, virtual time, seeded named RNG streams) · L3 world (`topology.json`, `world.cjs` **responders** standing in for effect handlers, `drivers.mjs`) · L4 observation (probes over the journal; invariant monitors on every step) · L5 experiments (replications, CRN, CIs, a byte-identical `sim-report`). Runs reproduce from `(artifact hashes, seed, runIndex)`.

**Surface.** Exports `polysim/kernel|streams|world|replication|experiment|twin` and a CLI. Private 1.0.6, **no licence file**, and the engine may not be changed without approval (enforced by commit hooks). Most of its worlds are scientific or financial, not agent workflows. polysim-cloud (AWS) and polygent-cloud host it.

**Platform fit.** The simulation plane: **pre-deployment what-if over a workflow version** (Jev-free responders standing in for agents and tools, seeded chaos), capacity planning, and a source of witnesses for polynv. The distinction to keep: `polyrun simulate` is kernel-parity DST (trust in the runtime); polysim is ensemble exploration (behavior of the fleet).

### 3.10 polysmith — LangSmith/LangGraph adapters (`C:\Users\jjdub\code\polysmith`)

**Designed only** (`docs/spec.md` v0.1 and `plan.md`, 2026-09-12; no code, no licence). A keystone `trace-adapter` turns a LangSmith run tree into three output profiles: `windows` (polygraph/polyvers), `interactions` (polyx-lens/polyx) and `episodes` (polyness). Thin adapters go three ways: **read** (export → corpus), **write** (verdicts → datasets, feedback, annotation queues, spans, all through a single `langsmith-writer`) and **in-path** (a LangChain `wrap_tool_call` middleware hosting a proved `next.cjs` through a stdio `decider-host`). It deliberately **excludes a polyflow durability adapter** because it overlaps LangGraph's durable execution; only the admission checker is in scope.

**Platform fit.** The export/observability plane's blueprint for OpenTelemetry-style and LangSmith export. The keystone adapter is the reusable piece: *one canonical run record → the three corpus forms*.

### 3.11 polygents (and polygent-cloud) — judgement products (`C:\Users\jjdub\code\polygents`)

**Purpose.** "Agents that give a verdict with evidence": a declared **mandate**, any model **interpreting** an artifact onto it, and the engines **judging** with a witness. There are three: **Formulator** (a Pyomo model checked against its brief), **Reviewer** (a PR diff read as windows and replayed against a machine kept in `.polygent/<name>/`) and **Guard** (polycheck plus mandate confinement). `polygent gate` decides whether a verdict may **block**: permit, escalate, hold or refuse, based on promotion and track record. Runs execute inside a certified `polygent-run` machine and are sealed. Private 0.1.0, commercial. The private engines run only in polygent-cloud (AWS, UNLICENSED).

**Platform fit.** A reference for the **mandate → interpret → judge** pattern and for **verdict-may-block governance**, which is how an enterprise platform promotes automated checks under human control.

### 3.12 polyjit — the evidence base (`C:\Users\jjdub\code\polyjit`, MIT)

A pre-registered measurement: **1.7%** of hard constraints survive JIT harness generation, and **0%** survive two compaction rounds. polyaxion's `proof/m2` imports this harness. For the platform, it is the quantitative argument that **workflow state and obligations must live outside the context window**.

### 3.13 polygraph-control-plane ("polygate") — CI merge gate (Apache-2.0)

A docs repo plus a GitLab CE mock with three jobs. `polygraph-check` runs keyless on every MR, `regenerate-specs` is the only key-bearing job and runs on a protected branch, and `push-artifacts` sends verdicts. It shows that a gamed hash is still caught by the model check. It is the **CI admission lane** for workflow definitions.

---

## 4. Mapping onto the platform's planes

| Plane | Primary component(s) | What exists | What the platform must add |
|---|---|---|---|
| **Authoring** | polygen; the polygraph `workflow` skill; polyness `propose`; polyx rules | intent → contract → SAM module → invariants → self-repair → corpus; journal-mined proposals | an authoring service and API (today these are CLI and plugin); a template library of "agent workflow" shapes; review UX for contract and invariants |
| **Verification / admission** | polygraph check, `check-effects`, `check-product`, polynv, polyflow `Library.certify`, polyaxion admission, polygate | exhaustive BFS over declared domains; emission invariants; joint parent×child; mutation adequacy; admission-before-registration | a signed **admission certificate** artifact bound to content hashes (polyflow keeps it in memory; polyaxion stores verdict digests); the MA-11 and MA-13 structural checks; a multi-tenant admission service |
| **Versioning** | polyvers (+ `polyrun deploy`, `polyrun migrate`) | lanes, fleet-seeded model check, migrate scaffold and gate, matrix and product, compat-report | wiring to polyflow (not done); version routing per instance (FR-6.3 exists in polyrun); rollout orchestration |
| **Runtime engine** | polyrun kernel (in polyflow), the polyflow work-order broker | ACID dispatch, dedupe, outbox, timers, children, poison, SQLite/Postgres, workers, HTTP facade | sharding and multi-region; an authenticated API; task queues and routing to agent pools; cross-language SDKs (JS only today) |
| **Multi-participant coordination** | polycrew | claims and leases, role offers, election, attribution, dashboard | a real broker service, authn/z, capability binding, human-actor provenance, fan-out/join, host wake events (all specified) |
| **Policy / constraints** | polyaxion (+ polyman), polycheck, polyflow `gate.mjs` | pre-execution guarded merge with witnesses, signed catalogue, receipts, recall; static PROOF/WITNESS lint | the order-scoped session integration with polycrew (specified); one policy language across the polyflow gate and polyaxion (§6) |
| **Learning** | polyness, polyx / polyx-lens, polynv harvest, the decision journal | event mining with provenance, replay scoring, retirement, adjudication, advisor with abstention | the loop from the platform journal back into mining (the specs say polyflow's journal is the ideal corpus; no reader exists yet) |
| **Judgement** | Jev (via the polyx observation port), polygents | calibrated `noul` facts with bands, frozen annotation; mandate → interpret → judge | Jev as a declared **effect kind** in workflows (probe only); calibration management |
| **Simulation** | polysim; `polyrun simulate` | virtual-clock DES over unchanged machines; kernel DST | agent and tool responders for agent workflows; a licence decision (polysim is private and unlicensed) |
| **Observability / export** | polyviz, polysmith (spec), the polyrun UI and fan-out, polycrew dashboard, `workflow_journal` | deterministic diagrams, read-only UIs, journal fan-out (FR-7.5) | OTel export, LangSmith adapters (unbuilt), metrics (FR-7.3 lists them), a run report (MA-16) |

---

## 5. Shared formats and integration seams

1. **The window `{pre, action, data, post}`** (+ `step_kind`, `reject_reason`, `action_id`, `machine_version`, `seq`). This is the universal currency. The polyrun journal, polygraph traces, polyvers stimuli, polysim journals, polynv precedence mining and polygents' Reviewer interpretation all use it, and polysmith's `windows` profile is designed to emit it. **Any platform event store should keep this row shape verbatim.**
2. **The SAM v2 strict module surface** `{instance, init, actions, getState, setState}` plus `lastStep()` and `manifest()`. Every engine loads machines through it (`scripts/sam-adapter.cjs` wraps modules into `{init, next}` so the checker and replayer agree on semantics).
3. **The effect intent and manifest** (`kind`, `payload`, `onSuccess`, `onFailure`, `onExhausted`, `retry`). polyrun executes it, polyflow turns it into work orders, polysim routes it to responders, and polyaxion's crew integration treats it as the order's *declared authority*.
4. **The rule-name vocabulary** (`no-X-without-a-prior-Y`, `at-most-one-X-per-run`, `X-implies-a-prior-Y`, `exactly-one-…`). It is shared by polyness proposals, polyflow effect invariants, `gate.mjs` `guardsOf()` (which parses rule names to find guarded effects) and polyx Declare patterns. The name is load-bearing: the enforcement point infers what to guard from it. That is fragile, and a structured `guards: <kind>` field would be safer.
5. **Consequence labels.** ACV 1.0 (`none|reversible|compensable|irreversible`, polyx/lens) and polyaxion's signed label catalogue (effect classes, reversibility, sensitive, untrusted) cover the same ground in two vocabularies (§6).
6. **Derived identity.** polyflow instance ids (`agent|instance|workflow|key`, key from a validated template), polyrun child ids (`hash(parent, childKey, seq)`), polycrew minted actors, and polyaxion sessions (`<instanceId>::<orderId>`). The idea is the same everywhere: *anything a model can name, a model can name wrongly.*
7. **Loopback port election** (polycrew broker, polyaxion gate): the same single-writer idiom in two codebases.
8. **Decision journals.** polyflow `.polyness/decisions.jsonl` (allow, deny, override), polyaxion windows plus receipts, the polyx advisor decision log. There are three, and all feed learning (§6).
9. **MCP as the agent boundary.** polyflow and polycrew (hand-rolled stdio), polyaxion (merge, recall, journal), polyness (`workflow_suggest`), polygents (`polygent_<name>`), polysim-cloud.

---

## 6. Overlaps and duplication

- **Three enforcement points for "don't do X before Y".** These are polyflow's `adapters/claude-code/gate.mjs` (open-order correspondence, argv-prefix matching, decisions JSONL), polyaxion's guarded merge (PX rules and machines, signed catalogue, receipts) and polyx's `examples/claude-code-hook` (advisor-driven blocking). polycheck guard is a fourth, narrower one. They differ in authority. polyflow asks "is a run waiting for this step?", polyaxion asks "does this sequence violate a declared obligation?", and polyx asks "does mined history say something should have happened first?" But all three are `PreToolUse` gates with their own matchers and journals. **The platform should choose polyaxion's kernel as the single enforcement point.** Express polyflow's open-order check as a native obligation or a run-scoped var, and treat polyx warnings as an escalate-severity input.
- **Two tool-call canonicalizers.** `polyflow/src/match.mjs argvOf()` and polyness `normalise.mjs` versus polyaxion's extractor (chains split per command, redirects as writes, `shell.opaque`). polyaxion's is the more complete.
- **Two consequence vocabularies.** ACV 1.0 and polyaxion's label catalogue should be reconciled into one signed catalogue with ACV ordinals.
- **Two miners.** polyness (Apache, dev-agent, four patterns) and polyx (BUSL, general, Declare, advisor). polyx treats polyness as a swappable port. For a platform, polyx is the superset. polyness's value is the proposal writer into polyflow's format.
- **Two stores and brokers for orders.** polyflow's in-memory broker versus polycrew's `pf_orders`; the attribution join-on-read versus the MA-14 journal columns. The polyrun journal should gain `actor`, `order_id` and `provenance` columns.
- **Two single-writer elections** (polycrew, polyaxion) and **several read-only UIs** (polyrun `GET /`, polycrew dashboard, polyaxion console, polysec console).
- **Simulation twice.** `polyrun simulate` (kernel-parity DST) and polysim (ensemble DES) are distinct by design and documented as such. That is not duplication, but it is easy to confuse.
- **polysec lives twice.** A standalone `C:\Users\jjdub\code\polysec` (the enterprise edition) and the merged `polyaxion/packages/polysec`. The merged copy is canonical per `polyaxion/CLAUDE.md`.
- **Certificates.** polyflow keeps admission results in memory (`this.certificates`) and re-certifies at every boot. polyaxion stores verdict digests and binds them into receipts. polyrun's `deploy` produces a gate result. There is no single persisted, hashed admission certificate format.

---

## 7. Gaps for an enterprise durable-execution platform

1. **Tenancy, authentication, authorization.** None anywhere: polycrew has "no authentication", polyaxion's trust boundary is the local user, and CR-016's `approved.by` is a free string. The human-actor `verified` provenance (MA-18) and a principal model are prerequisites for four-eyes rules.
2. **Scale-out runtime.** polyrun targets one Postgres (NFR-1: ≥500 steps/s, 100k active instances). There is no sharding, no multi-region, no task-queue routing and no worker versioning. polyflow is stdio per session. polycrew is one machine.
3. **Language reach.** Machines are JS/SAM only. Handlers are "yours" in JS. polysmith's Python side (decider-host over stdio) is the only cross-language design, and it is unbuilt.
4. **Admission certificate as a first-class artifact.** It needs content hashes of all six files, invariant names, `pathsExplored`, the bounded flag, the adequacy grade and the polyvers lane history, signed, and bound into journal rows (see polyaxion's receipt binding).
5. **The gate's structural checks** (MA-11 "every waiting state arms a timer", MA-13 product invariants, role and capability satisfiability) are specified and not built.
6. **Journal integrity.** polyflow and polyrun journals are not hash-chained or signed. polyaxion has the design (ed25519 per window, chained, replay-verify), and it should be adopted for workflow journals too (the polyflow README's "Signed journals" item).
7. **polyvers ↔ polyflow wiring.** A changed workflow in the library is simply re-certified at boot. No lane check against in-flight runs happens (README: "not wired in").
8. **Long-running agent work.** The broker heartbeat keeps a polyrun lease alive while an agent works. The spec calls lease extension second-class and recommends request/callback. For agent turns lasting hours, and for human orders (MA-7 exempts humans from lease expiry), the platform needs explicit "awaiting external" states rather than parked promises.
9. **Data abstraction gap.** Every gate covers declared representative values only, and "no gate measures" the gap. For agent payloads (free text, amounts), Jev-derived `obs.*` facts plus finite abstractions are the proposed bridge, and that bridge is only specified for polyx.
10. **Observability export.** Metrics exist as a spec list (FR-7.3). There is no OTel. The LangSmith adapter is unbuilt. The run report (MA-16) is unbuilt.
11. **Licensing heterogeneity.** Apache-2.0 (polygraph, polyflow, polycrew, polycheck, polyness, polyx-lens, polyman as published), BUSL-1.1 (polyx), MIT (the Jev adapter, polyjit), ISC (sam-pattern), source-available commercial (polyaxion, polygents), unlicensed/private (polysim, the clouds). An enterprise platform that bundles polyaxion or polysim inherits their commercial terms. The polyaxion licence text is not yet written.
12. **Recognition and learning quality.** polyness recognition is at 1/15. polyx precision sits at the BETWEEN verdict, and alignment and gold data are still open. Learning should stay advisory, with human adjudication (as all of these tools already insist).
13. **Operational hygiene on Windows.** A CRLF checkout breaks one polyflow test. polygraph pins LF with `.gitattributes`; polyflow should do the same.

---

## 8. Doctrines and writing style

The ecosystem is unusually consistent in its principles, and a platform built on it should inherit them explicitly, because they are what make its guarantees mean something.

**Epistemic doctrines (polygraph ARCHITECTURE §Design doctrines, repeated in every repo):**
- **Consistency check, not a proof.** "Exhaustive" means exhaustive *over the finite declared domains*. Every README opens with a scope disclosure.
- **No silent-clean paths.** BOUNDED exploration fails. Empty invariant sets are refused. An empty corpus is refused. `INCONCLUSIVE`, never a green tick (polygents has a test for it).
- **Observable rejection.** Every non-applicable action is `reject(reason)`, contract-anchored. A reject is a *result*, not an error. That single property makes at-least-once delivery, stale timers and cross-version stimuli safe.
- **Controls before trust.** A positive and a negative control precede any generated-artifact claim.
- **Ground truth is executed code.** Traces come from the real system running (the journal is the best corpus), never from expectations.
- **Defect → gate.** Every failure found becomes a mechanical check.
- **Witnesses, not refusals.** A denial carries the obligation, the bindings and the violating sequence, so the model re-plans (polyaxion, polycheck WITNESS, shortest counterexamples everywhere).
- **Poison what "cannot happen", loudly.**
- **The repair loop fixes code, never invariants.** An invariant encodes intent.
- **Anything a model can name, a model can name wrongly.** Identity, roles, actors and run keys are derived or minted, never taken from tool arguments.
- **No model on the decision path.** Models interpret, propose and fulfil orders; engines decide. Probabilistic inputs are journaled data (doctrine 22).
- **Absent evidence is unobserved, never clean** (doctrine 24). Three-valued logic and no closed-world assumption (polyx, PX).
- **Proposing is a claim; scoring is an observation** (polyness and polyx provenance). Rules carry support, counter-evidence and a mined-at date, and they can be **retired**, which a memory file cannot.
- **Silence is an answer.** A tool that manufactures a finding for a project with nothing to say is worse than one that stays quiet.
- **A refusal is an answer, not an error**, so a model moves on instead of retrying (polycrew `claimed:false`).
- **Narrow fail-closed.** The blast radius equals the promise (the polyflow gate). A control-plane outage must never stop running things (doctrine 28).

**Writing style.** Plain declarative prose that measures before it claims: n and CI stated, negative results published (polycheck FIELD-NOTES; polyflow phase 3 §4 "the control is just as safe — say so"), and retractions logged openly (polyx FS rev. 11). Headlines are one-sentence theses. Every number is traceable (`--show`). "What this does not do" sections are mandatory. Code comments explain the *why*, name the failure a line prevents, and cite spec ids (`MA-7`, `FR-3.4`, `doctrine 26`). Tests are named as claims ("a denial is a result, not a fault"). Specs change before code when the two disagree.

---

## 9. Recommendations for the platform team, in order

1. **Adopt polyrun as the kernel and polyflow's work-order inversion as the agent contract.** Keep the six-tool MCP surface and derived identity. Move the polycrew broker contract to a networked, authenticated service backed by Postgres.
2. **Make the admission certificate a persisted, signed artifact** and bind its digest into every journal row, reusing polyaxion's notary design. Hash-chain the workflow journal.
3. **Wire polyvers in front of library changes.** A workflow edit with live runs must pass the lanes over `polyrun archive` snapshots, or be refused.
4. **Unify enforcement on polyaxion's kernel.** Retire the separate polyflow and polyx hooks as independent gates, and reconcile ACV with the label catalogue.
5. **Build the specified polycrew C1–C3 items** that enterprise needs first: principals and verified human provenance, the capability binding, timers-on-waits and product checks at admission, and the deterministic run report.
6. **Treat Jev as an effect kind with a journaled result.** Declare predicates and bands, never call it inside an acceptor, and prefer `noul` batteries.
7. **Close the learning loop on the platform's own journal.** Build a polyflow-journal reader for polyness and polyx. It needs no alphabet work, because the journal is already typed windows.
8. **Resolve licensing before bundling** polyaxion, polyx or polysim.
