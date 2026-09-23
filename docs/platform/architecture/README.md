# Polyflow for Temporal — architecture

A governance layer for AI agents on Temporal: it records every effect in a hash-chained ledger, checks rules before each effect, hosts certified state machines that decide what happens next, and gates new versions against the live fleet. It installs as a worker plugin and changes nothing about the customer's workflows.

Analysed at [`f34767c`](https://github.com/cognitive-fab/polyflow/tree/f34767c0842708840d9b86c46cb178bfa808277a).

**Read from.** platform/packages/{kernel,temporal,cli,gateway,service}/src (code); platform/python/{polyflow_temporal,polyflow_langgraph} (code); docs/platform/02-technical-spec.md (document); docs/platform/reviews/ (document).

> Generated from the analysis by archlens. Edit the analysis, never this file.

## What this architecture answers

### What happens when a workflow schedules an activity

**A customer's unchanged workflow calls an activity. Where does Polyflow enter, and what gets recorded?**

The whole adoption story rests on one claim: install the plugin and nothing about the workflow changes. That is only credible if the interception point is one Temporal already offers, and if the record it produces survives without any new infrastructure.

The outbound interceptor, last in the chain, sees the call, records a proposal and a verdict, and carries the pending events on the activity's own header. Temporal persists that header in history, so the record exists before any sink does.

[Open the diagram](record.architecture.html) — 5 components.

| Component | Responsibility |
|---|---|
| **Customer workflow** | Runs the customer's agent loop exactly as written; it never learns that Polyflow exists except through a denial it can read. |
| **Workflow interceptor** | Turns every activity, child, signal and Nexus call into proposal, verdict, effect and observation events, and carries the ledger on activity headers. |
| **Ledger chain** | Appends events into one hash chain per run and verifies a chain offline. |
| **Temporal server** | Persists every workflow task, activity and header; the platform relies on it for durability and replay and adds no store of its own. |
| **Exporter** | Reads the ledger delta off an activity's header, verifies it chains from what the sink holds, signs the head it verified, and writes both. |

**Deliberately not shown.** The guard's rules (question two), and the sinks and service (question three).

#### The long read

Start at the customer's workflow: it calls an activity exactly as it did before the plugin. The Temporal SDK passes that call through every registered outbound interceptor, and Polyflow's is registered last on purpose, so it sees the final activity type and arguments after every other plugin has had its say.

Inside the interceptor two things happen in the same synchronous step. First, the rule kernel classifies the call and decides it (at G0 every decision is allow). Second, the ledger appends a proposal and a verdict, and then an effect event carrying an idempotency key. None of these events holds the arguments, only a digest of them.

Then the interceptor drains everything the ledger has appended since the last carrier and attaches it to the activity's header. The command goes to the Temporal server, which writes the header into the workflow's history. From this moment the record is durable: even if every sink is down, the history holds it, and the CLI can rebuild the ledger from a history export.

When the activity task reaches a worker, the exporter reads the header before the customer's activity code runs, which is the next question. When the activity completes, an observation event records ok or a redacted error, and rides on the next carrier.

#### Terms used here

- **effect** — Anything a workflow does that reaches the outside world: an activity, a child workflow, a signal to another workflow, a Nexus operation. The unit the guard decides and the ledger records.
- **ledger** — One hash chain per run of proposal, verdict, effect and observation events, signed at its head by the worker's deployment key.
- **delta** — The events appended since the last activity was scheduled, carried on that activity's header.
- **sink** — Where the exporter writes ledgers: a directory, memory, or the governance service.
- **Continue-as-New** — Temporal's way to start a fresh execution with a carried state, keeping history bounded; the hand-over point for versions.

### How an effect is decided at G1

**With a policy configured, what decides whether a call may proceed, what does a denial look like, and how does a person get involved?**

Rules that live in ad-hoc guards inside activities are invisible to audit and differ per team. G1 moves them to one place that replays exactly, and it has to give the agent something better than an error string when it says no.

The rule kernel decides from the run's own history and the admitted policy. A denial fails the call before it is scheduled with a witness; an escalation parks a frozen copy of the call until a person with the role answers, through an Update the interceptor installs.

[Open the diagram](guard.architecture.html) — 5 components.

| Component | Responsibility |
|---|---|
| **Customer workflow** | Runs the customer's agent loop exactly as written; it never learns that Polyflow exists except through a denial it can read. |
| **Workflow interceptor** | Turns every activity, child, signal and Nexus call into proposal, verdict, effect and observation events, and carries the ledger on activity headers. |
| **Rule kernel** | Decides each candidate effect from the run's own history and the pinned policy, and produces a witness for every denial. |
| **Policy admission** | Parses and admits a policy: every rule known, every guarded kind declared and reachable, routes validated. |
| **Approver** | Answers escalations and performs human orders; with a trust store, presents a token signed for the one action. |

**Deliberately not shown.** Plan admission and verified principals, which have their own questions; the ledger, which records the outcome but never influences it.

#### The long read

The policy is admitted before it is ever used: every rule must be of a known type, every guarded kind must be declared by some effect, and no rule may make a kind unreachable. What the worker enforces is the admitted, digested form, and at guard level an omitted unlabelled setting is enforced as deny.

When the interceptor sees a call it builds a candidate: the kind and class the policy assigns to that activity (or to the tool the call carries, when a route says so), its labels, and a digest of the arguments. The guard evaluates every rule against the run's state: what has been scheduled, what succeeded, what was read, how much was spent. Every failing rule is reported, not just the first.

A deny becomes a PolyflowDenied failure thrown to the workflow before the command is emitted. Its details carry the witness: each rule and the fix that would satisfy it, plus the kinds that are allowed right now. An agent that reads it re-plans instead of retrying.

An escalate parks the call. The interceptor freezes a copy of the arguments, records an escalated verdict, and waits, in workflow time, for polyflow.approve. The approver reads polyflow.pending, sees exactly those arguments, and answers. With a trust store, the answer is a token signed for that one approval, verified by the principals kernel inside the isolate. No answer inside the policy's timeout is a denial.

An agent that wants to do several things may propose a plan. Plan admission steps the guard from the run's current state through every order the plan could execute, so a plan is admitted only if no order breaks a rule, and each step still crosses the guard when it runs.

#### Terms used here

- **effect** — Anything a workflow does that reaches the outside world: an activity, a child workflow, a signal to another workflow, a Nexus operation. The unit the guard decides and the ledger records.
- **kind** — The name a policy gives to a class of effects (post, approval, refund), so rules talk about kinds rather than activity names.
- **witness** — What a denial carries: the rules that fired, how to satisfy each, and the kinds allowed right now.
- **ledger** — One hash chain per run of proposal, verdict, effect and observation events, signed at its head by the worker's deployment key.
- **work order** — What a machine step emits: an effect of a declared kind that a worker activity, an agent or a person performs and reports.
- **admission** — The CI step that checks a machine or a policy exhaustively over its declared domain and writes a signed certificate.
- **escalation** — A guard outcome that parks a call, frozen, until a person with the right role decides it.
- **principal** — Whoever approves, reports or claims; verified when they present a token signed by a trusted key for that one action.
- **Continue-as-New** — Temporal's way to start a fresh execution with a carried state, keeping history bounded; the hand-over point for versions.
- **isolate** — The sandbox the Temporal TypeScript SDK runs workflow code in: no I/O, a deterministic clock, replayable.

### How the ledger reaches a verifier

**Once a delta is in history, how does it become a signed record someone else can verify, and what stops a worker from signing a forgery?**

A record nobody vouches for says only what happened. The signing point has to be somewhere with a key, which the isolate is not, and it must refuse to sign anything it did not check itself.

The exporter, an activity-side interceptor on the worker, reads the delta off the header, verifies it chains from what the sink already holds, signs the head it verified with the deployment key, and writes both. The CLI or the service verifies the chain, the signatures and the closure offline.

[Open the diagram](export.architecture.html) — 7 components.

| Component | Responsibility |
|---|---|
| **Temporal server** | Persists every workflow task, activity and header; the platform relies on it for durability and replay and adds no store of its own. |
| **Exporter** | Reads the ledger delta off an activity's header, verifies it chains from what the sink holds, signs the head it verified, and writes both. |
| **Sinks** | Holds a run's events idempotently and refuses whole any delta that conflicts or forks. |
| **Service API** | Accepts deltas from many workers, verifies signed heads against namespace-bound trust, and serves runs, reports, alerts and metrics. |
| **Service store** | Stores contiguous chains, holds back out-of-order deltas, and raises conflict, fork and gap alerts. |
| **polyflow CLI** | Runs every offline check an operator or CI needs: verify a ledger, rebuild one from history, admit a policy or a machine, vet a version. |
| **Evidence pack** | Derives compliance evidence from the ledgers a service holds, and says 'nothing in scope' rather than passing an empty period. |

**Deliberately not shown.** Sealing, which is question eight; the workflow side, which is question one.

#### The long read

An activity task arrives at a worker carrying the ledger delta in its header. Polyflow's activity interceptor runs before the customer's activity code. It opens the header (and requires a seal when the worker has a data key), then checks four things: the delta names this activity's own workflow and namespace; if it starts a chain it names this activity's own run; its events chain internally; and it continues from the head the sink already holds.

Only then does it sign, and it signs the head it computed, never a head the payload claims. A delta that skips ahead is written unsigned so the gap shows, and reported. A delta that conflicts with what the sink holds is refused whole and reported through onConflict: two different events at one seq of one run is what tampering looks like.

The sink can be a directory, memory, or the governance service over HTTPS. The service holds back an out-of-order delta until its predecessor arrives, refuses forks, verifies signed heads against a trust store bound to namespaces, and requires a signed head on the first delta of any run where it trusts a key, so a write token alone cannot invent a run.

Verification is offline: polyflow verify reads a run's file, checks the chain, checks that a trusted key signed a head anchored on the last event, and checks the closure. The service does the same per run and derives the evidence pack from what it holds.

#### Terms used here

- **ledger** — One hash chain per run of proposal, verdict, effect and observation events, signed at its head by the worker's deployment key.
- **delta** — The events appended since the last activity was scheduled, carried on that activity's header.
- **sink** — Where the exporter writes ledgers: a directory, memory, or the governance service.
- **machine** — A SAM v2 state machine plus its contract, effect mapper and manifest: the certified artefact a governed run hosts.
- **work order** — What a machine step emits: an effect of a declared kind that a worker activity, an agent or a person performs and reports.
- **certificate** — A signed record of every file, module, guarantee and check of an admitted machine; its buildId is the version.
- **Continue-as-New** — Temporal's way to start a fresh execution with a carried state, keeping history bounded; the hand-over point for versions.
- **isolate** — The sandbox the Temporal TypeScript SDK runs workflow code in: no I/O, a deterministic clock, replayable.

### What a governed run is

**At G2 the agent no longer drives the sequence. What does, who performs the work, and how does an agent outside the worker take part?**

G1 constrains an agent's choices; G2 removes the choice of what comes next altogether and leaves the agent only how. That is the level where a rewrite is asked of the customer, so it has to be clear what is gained.

GovernedWorkflow steps a certified SAM machine. Each accepted step emits work orders and timers; orders run as worker activities or wait for an external performer through the gateway, and every completion is a proposal the machine accepts or observably rejects.

[Open the diagram](governed.architecture.html) — 6 components.

| Component | Responsibility |
|---|---|
| **GovernedWorkflow** | Steps a certified machine, issues its work orders as activities or external orders, answers Updates, and hands over across Continue-as-New without losing anything. |
| **SAM machine host** | Fires one action against a snapshot and returns the accepted state, its orders and timers; the same code runs in admission and in QuickJS. |
| **Machine directory** | Holds everything a machine is: descriptor, contract, SAM module, pure effect mapper, manifest, invariants, batteries. |
| **Workflow interceptor** | Turns every activity, child, signal and Nexus call into proposal, verdict, effect and observation events, and carries the ledger on activity headers. |
| **MCP gateway** | Offers governed runs to any MCP agent as work orders, and turns each report into a polyflow.report Update signed for that one action. |
| **MCP agent** | Performs the work orders a governed run offers, using whatever tools it has, and reports the outcome. |

**Deliberately not shown.** Admission and certificates, which are question five; the judge, which is question nine.

#### The long read

A machine directory holds a SAM v2 module, its contract, a pure effect mapper and a manifest. The plugin bundles the module into the worker and registers it by name; the customer's workflows module re-exports GovernedWorkflow, and that is the only workflow code involved.

A run starts from an input. The workflow id is derived from it by the descriptor's key template, so starting the same job twice attaches to the same run instead of running it twice. The start step fires the input action; the host fires it against the initial snapshot and returns the accepted state plus the orders and timers the mapper emits. Orders get ids derived from the run, the seq and the kind, so a retry re-issues the same order.

In worker mode each order is an activity, scheduled through the same interceptor as any other effect, so a governed run is guarded and recorded like a G1 run. Its completion becomes the action the manifest wires (onSuccess, onFailure, onExhausted), stepped as a proposal the machine may accept or reject.

In external mode nothing is scheduled: the order waits. The MCP gateway offers the run to an agent as work orders through six unchanged tools. The agent reports through polyflow.report, which the workflow validates against the open order, its holder and its role before anything is stepped. A person's order is reported only by someone holding the human role.

Updates, timers and hand-overs all go through the same step function, so the journal is the complete story of the run: every accepted, rejected and unhandled step with its pre and post state.

#### Terms used here

- **effect** — Anything a workflow does that reaches the outside world: an activity, a child workflow, a signal to another workflow, a Nexus operation. The unit the guard decides and the ledger records.
- **kind** — The name a policy gives to a class of effects (post, approval, refund), so rules talk about kinds rather than activity names.
- **ledger** — One hash chain per run of proposal, verdict, effect and observation events, signed at its head by the worker's deployment key.
- **machine** — A SAM v2 state machine plus its contract, effect mapper and manifest: the certified artefact a governed run hosts.
- **work order** — What a machine step emits: an effect of a declared kind that a worker activity, an agent or a person performs and reports.
- **admission** — The CI step that checks a machine or a policy exhaustively over its declared domain and writes a signed certificate.
- **certificate** — A signed record of every file, module, guarantee and check of an admitted machine; its buildId is the version.
- **Continue-as-New** — Temporal's way to start a fresh execution with a carried state, keeping history bounded; the hand-over point for versions.
- **QuickJS** — A small JavaScript engine; compiled to WebAssembly it runs the TypeScript machine host inside Python with no host access.
- **MCP** — Model Context Protocol: how an agent discovers and calls tools; the gateway exposes governed runs as MCP tools.

### How a machine is certified

**What does polyflow admit check, what does the certificate cover, and how does a worker refuse what was not admitted?**

G3 is the claim that nothing runs that was not checked. It needs the checks to be exhaustive over something, the certificate to cover the code that actually runs, and the worker to enforce it without trusting the person who deployed it.

Admission explores the machine over its contract's whole declared domain: effect invariants over every path, state invariants in every state, liveness, stops, waits and batteries. The certificate digests every file and local module and is signed; a worker with a trust store refuses any machine whose files differ by a byte.

[Open the diagram](admission.architecture.html) — 6 components.

| Component | Responsibility |
|---|---|
| **polyflow CLI** | Runs every offline check an operator or CI needs: verify a ledger, rebuild one from history, admit a policy or a machine, vet a version. |
| **Admission** | Runs every check a machine's artefacts support and writes a signed certificate naming the exact files only if all of them pass. |
| **Structural explorer** | Explores the machine over its declared domain and checks liveness, state invariants, stops and that every wait has an exit. |
| **polygraph / polyvers** | Checks effect invariants over every path (check-effects) and classifies a version change into compatibility lanes with validated migrations (polyvers). |
| **Certificates** | Digests every certified file and local module, signs and verifies certificates, and refuses a machine whose files changed. |
| **Machine directory** | Holds everything a machine is: descriptor, contract, SAM module, pure effect mapper, manifest, invariants, batteries. |

**Deliberately not shown.** The runtime host that steps the same machine, and the worker's refusal, which is question four's plugin.

#### The long read

Admission begins by refusing to guess: the machine's own action domains must cover every combination the contract declares, or the certificate would name a domain nobody explored. Then polygraph's check-effects walks every path over that domain and checks the effect invariants: what may never be emitted, in what order, how many times.

The structural explorer walks the same machine through the same host that will run it: can every state finish; do the state invariants hold everywhere; does every step that hands work to a person arm a timer; can a person stop the run from every state not declared unstoppable; does every wait have an exit somebody actually sends, for every outcome of every order open there. That last check found a real gap in the platform's own example.

Batteries are parsed, their calibration checked, and every fact a manifest reads must be one some battery produces. A policy.json, if present, is admitted and its digest recorded, and the machine will then run only under that policy.

If everything passes, the certificate names each artefact by digest, including every local module the machine requires through a literal path, and the version of the SAM library. It is sealed with its own digest and signed with a CI key. Its buildId is a function of what was certified, not of when.

At worker start the plugin recomputes every digest and compares it with the certificate, checks the signature against the trust store, and checks the installed SAM version. One changed byte, and the worker names the file and refuses to start.

#### Terms used here

- **effect** — Anything a workflow does that reaches the outside world: an activity, a child workflow, a signal to another workflow, a Nexus operation. The unit the guard decides and the ledger records.
- **witness** — What a denial carries: the rules that fired, how to satisfy each, and the kinds allowed right now.
- **ledger** — One hash chain per run of proposal, verdict, effect and observation events, signed at its head by the worker's deployment key.
- **machine** — A SAM v2 state machine plus its contract, effect mapper and manifest: the certified artefact a governed run hosts.
- **work order** — What a machine step emits: an effect of a declared kind that a worker activity, an agent or a person performs and reports.
- **admission** — The CI step that checks a machine or a policy exhaustively over its declared domain and writes a signed certificate.
- **certificate** — A signed record of every file, module, guarantee and check of an admitted machine; its buildId is the version.
- **Continue-as-New** — Temporal's way to start a fresh execution with a carried state, keeping history bounded; the hand-over point for versions.
- **polyvers** — The polygraph tool that classifies a machine change into compatibility lanes and validates migrations over live states.
- **battery** — A declared set of typed questions for the judge, each with calibrated bands that turn a probability into a fact, or into none.

### How a new version reaches the live fleet

**A machine changes shape while runs are in flight. How is the change vetted, and how does a run move to the new version without replaying across it?**

Every Temporal customer has this problem, and the usual answer is patching workflow code with version markers. Polyflow's answer is that a run never replays across versions at all; it hands its state over. That only works if the migration was validated against the very state being moved.

The gate vets the new version against every distinct live state with polyvers before promotion and tells each moving run to wait; after the Worker Controller promotes, a wake phase lets each run Continue-as-New onto the new version, carrying its migrated state and open orders. Any run that would have to be pinned fails the gate.

[Open the diagram](versioning.architecture.html) — 6 components.

| Component | Responsibility |
|---|---|
| **Gate workflows** | Reads the live fleet, applies vet's decisions to each run, wakes waiting runs after promotion, and vets a policy change against guard states. |
| **vet** | Decides per live run whether a new version may take it over: auto-upgrade, migrate, or pin. |
| **polygraph / polyvers** | Checks effect invariants over every path (check-effects) and classifies a version change into compatibility lanes with validated migrations (polyvers). |
| **Certificates** | Digests every certified file and local module, signs and verifies certificates, and refuses a machine whose files changed. |
| **GovernedWorkflow** | Steps a certified machine, issues its work orders as activities or external orders, answers Updates, and hands over across Continue-as-New without losing anything. |
| **Temporal server** | Persists every workflow task, activity and header; the platform relies on it for durability and replay and adds no store of its own. |

**Deliberately not shown.** The policy ramp gate for G1 workflows, which uses the same activities over guard states instead of machine states.

#### The long read

Two certified versions exist, each on its own worker deployment version whose build id is its certificate's. Runs on v1 are pinned there.

The gate workflow's first phase reads the fleet: every running governed run of the machine on the old build id, with its machine state and its open order kinds. vet refuses to look at a new version that was not admitted, then runs polyvers once per distinct state. polyvers classifies the change into lanes and runs the gates that lane needs, including migration validation over that exact state. Per run the decision is auto-upgrade, migrate with a specific migrated state, or pin. A run with an open order the new version cannot complete is pinned too.

If any run pins, the gate fails and nothing is promoted; keeping those runs on the old workers is the operator's decision, not a default. Otherwise the gate applies each decision through polyflow.migrate, carrying the digest of the state it was computed from and, with verified principals, a token bound to that run and target. The run records the pending migration and waits.

The operator promotes v2. The gate's wake phase signals each waiting run; on that activation the run sees its target version changed and continues as new with AUTO_UPGRADE, computing what it carries after its closing flush so nothing accepted during the hand-over is lost. The new execution runs on v2, re-issues open orders under the same ids, and its new actions work on a run that started under v1. If the run moved on since the gate read it, the migration is dropped and the gate re-vets.

#### Terms used here

- **effect** — Anything a workflow does that reaches the outside world: an activity, a child workflow, a signal to another workflow, a Nexus operation. The unit the guard decides and the ledger records.
- **kind** — The name a policy gives to a class of effects (post, approval, refund), so rules talk about kinds rather than activity names.
- **ledger** — One hash chain per run of proposal, verdict, effect and observation events, signed at its head by the worker's deployment key.
- **machine** — A SAM v2 state machine plus its contract, effect mapper and manifest: the certified artefact a governed run hosts.
- **work order** — What a machine step emits: an effect of a declared kind that a worker activity, an agent or a person performs and reports.
- **certificate** — A signed record of every file, module, guarantee and check of an admitted machine; its buildId is the version.
- **principal** — Whoever approves, reports or claims; verified when they present a token signed by a trusted key for that one action.
- **Continue-as-New** — Temporal's way to start a fresh execution with a carried state, keeping history bounded; the hand-over point for versions.
- **polyvers** — The polygraph tool that classifies a machine change into compatibility lanes and validates migrations over live states.

### Who may approve, report and claim

**Anyone with an Update permission can send polyflow.approve. How does the platform know who they are, and why is a token not enough?**

Temporal has no built-in notion of who sent an Update, and it keeps every accepted Update's arguments in history, readable by anyone with history access. A bearer credential in an Update is therefore a credential lying in a log.

With a trust store, every state-changing Update carries an ed25519 token minted outside the workflow and verified inside it. The token is bound to one action: for an approval, the approval id, run, decision and arguments digest. A lifted token can only repeat what history already records.

[Open the diagram](principals.architecture.html) — 5 components.

| Component | Responsibility |
|---|---|
| **Approver** | Answers escalations and performs human orders; with a trust store, presents a token signed for the one action. |
| **Workflow interceptor** | Turns every activity, child, signal and Nexus call into proposal, verdict, effect and observation events, and carries the ledger on activity headers. |
| **GovernedWorkflow** | Steps a certified machine, issues its work orders as activities or external orders, answers Updates, and hands over across Continue-as-New without losing anything. |
| **Verified principals** | Verifies, inside the isolate, that an approval, report or claim was signed by a trusted key for that one action. |
| **MCP gateway** | Offers governed runs to any MCP agent as work orders, and turns each report into a polyflow.report Update signed for that one action. |

**Deliberately not shown.** The rules that decide whether an approval is needed, which are question two.

#### The long read

The plugin takes a map of key ids to public keys. From then on the interceptor's approve validator, and every GovernedWorkflow validator for report, claim, propose, release and migrate, require a signed token instead of a name.

A token is minted where the person is already authenticated, by the identity bridge, the approvals console or the gateway, with signPrincipal. Its body names the key, the id, the roles, the namespace it may act in, an issue and expiry time, and the act: the operation, the workflow, and what the operation is about. For a report that is the order, its attempt and a digest of the outcome; for a migration, the run, the from-digest and the target.

The workflow verifies the signature itself with a pure-JavaScript ed25519 implementation, because the isolate has no crypto. It refuses by size and shape before hashing anything, so a large token cannot burn the workflow task's deadline. The validator verifies; the handler, which also runs on replay, takes the claims the validator already checked, so rotating a key out of the trust store does not break old runs.

An escalation shows the approver the frozen arguments; the token binds their digest, so the approver approves exactly what they saw and nothing else runs on that approval. The gateway mints a 60-second token per report or claim from its own key when it has one.

#### Terms used here

- **effect** — Anything a workflow does that reaches the outside world: an activity, a child workflow, a signal to another workflow, a Nexus operation. The unit the guard decides and the ledger records.
- **ledger** — One hash chain per run of proposal, verdict, effect and observation events, signed at its head by the worker's deployment key.
- **machine** — A SAM v2 state machine plus its contract, effect mapper and manifest: the certified artefact a governed run hosts.
- **work order** — What a machine step emits: an effect of a declared kind that a worker activity, an agent or a person performs and reports.
- **escalation** — A guard outcome that parks a call, frozen, until a person with the right role decides it.
- **principal** — Whoever approves, reports or claims; verified when they present a token signed by a trusted key for that one action.
- **Continue-as-New** — Temporal's way to start a fresh execution with a carried state, keeping history bounded; the hand-over point for versions.
- **MCP** — Model Context Protocol: how an agent discovers and calls tools; the gateway exposes governed runs as MCP tools.
- **isolate** — The sandbox the Temporal TypeScript SDK runs workflow code in: no I/O, a deterministic clock, replayable.

### What keeps the record confidential and tamper-evident

**The ledger lives in history and on disks other people can read. What stops them reading it, and what shows if someone changes it?**

NFR-7 says the platform must be compatible with the customer's codec and never need plaintext. Temporal's payload codecs, though, skip headers, which is exactly where the ledger travels.

Confidentiality: with a worker-held data key the interceptor seals headers with ChaCha20-Poly1305 under a keyed synthetic nonce, and the exporter refuses plaintext. Tamper evidence: every event hashes its predecessor, the exporter signs verified heads, sinks refuse conflicts and forks whole, and the service raises alerts.

[Open the diagram](integrity.architecture.html) — 5 components.

| Component | Responsibility |
|---|---|
| **Workflow interceptor** | Turns every activity, child, signal and Nexus call into proposal, verdict, effect and observation events, and carries the ledger on activity headers. |
| **Sealed headers** | Seals the ledger delta and the hand-over head before they reach history, because payload codecs skip headers. |
| **Ledger chain** | Appends events into one hash chain per run and verifies a chain offline. |
| **Exporter** | Reads the ledger delta off an activity's header, verifies it chains from what the sink holds, signs the head it verified, and writes both. |
| **Sinks** | Holds a run's events idempotently and refuses whole any delta that conflicts or forks. |

**Deliberately not shown.** Verified principals, which are question seven, and the service's tenancy and rate limits.

#### The long read

Two properties, two mechanisms. Tamper evidence comes from the chain: each event's hash covers its predecessor's, the deployment key signs the head of each verified delta, and a verifier walks the chain and checks that a trusted signature anchors its last event. A sink that already holds a different event at some seq refuses the whole delta and reports it; the service records conflict, fork and gap alerts and can page them.

Confidentiality is the harder one, because payload codecs do not touch headers. The plugin takes a 32-byte data key. Inside the isolate the interceptor seals the delta and the hand-over head with ChaCha20-Poly1305. The nonce is not random: it is an HMAC under a key derived from the data key over the context and the plaintext, so it is identical on every replay of the same task and different whenever the content differs. The context (key id, run, purpose, seq) is bound into the authenticated data, so a sealed body from one run does not open as another's.

The key never touches disk: the generated interceptor module carries only the key id, and webpack injects the key into the in-memory bundle at worker start. A pre-built bundle that would contain it is refused unless the operator says so. The exporter, the next execution and polyflow export open sealed headers; where keys are configured the exporter refuses a plaintext delta.

One open defect belongs here: under some Temporal replays the event times of a run's first activation differ between two replays of the same history, which can fork the exported chain at a hand-over. It is tracked as DST1-R and kept visible as a todo test.

#### Terms used here

- **effect** — Anything a workflow does that reaches the outside world: an activity, a child workflow, a signal to another workflow, a Nexus operation. The unit the guard decides and the ledger records.
- **ledger** — One hash chain per run of proposal, verdict, effect and observation events, signed at its head by the worker's deployment key.
- **delta** — The events appended since the last activity was scheduled, carried on that activity's header.
- **sink** — Where the exporter writes ledgers: a directory, memory, or the governance service.
- **principal** — Whoever approves, reports or claims; verified when they present a token signed by a trusted key for that one action.
- **Continue-as-New** — Temporal's way to start a fresh execution with a carried state, keeping history bounded; the hand-over point for versions.
- **isolate** — The sandbox the Temporal TypeScript SDK runs workflow code in: no I/O, a deterministic clock, replayable.

### How judgement enters a machine

**Some steps need a judgement no rule can express. How does a machine ask, what comes back, and what keeps the judge from deciding anything by itself?**

The theme is determinism without disrupting what makes an agent smart. A judge is the one place a model contributes to a state machine, so the contract around it decides whether the machine stays checkable.

A machine orders an observation like any other effect. The activity sends only the battery's declared source fields, redacted, to Jev and maps each probability through calibrated bands into true, false or no fact. The facts are recorded as the activity result, so replay never calls the judge again.

[Open the diagram](judgement.architecture.html) — 5 components.

| Component | Responsibility |
|---|---|
| **GovernedWorkflow** | Steps a certified machine, issues its work orders as activities or external orders, answers Updates, and hands over across Continue-as-New without losing anything. |
| **SAM machine host** | Fires one action against a snapshot and returns the accepted state, its orders and timers; the same code runs in admission and in QuickJS. |
| **Judge activity** | Sends only the battery's declared source fields, redacted, to Jev, and maps each probability through calibrated bands into a fact or no fact. |
| **Jev (typesafe.ai)** | Answers a typed question about a state with a probability; never with text. |
| **Machine directory** | Holds everything a machine is: descriptor, contract, SAM module, pure effect mapper, manifest, invariants, batteries. |

**Deliberately not shown.** Human escalation, which handles 'no fact' when the contract says a person decides.

#### The long read

A battery is part of the machine directory: named questions of type noul, each with instructions, an assert band, a refute band and a calibration record naming the model it was measured on. Admission parses it, requires the model and the declared source fields, checks the calibration against a bar (sample size, at least fifteen of each label, precision at least 0.9, the same model), and checks that every fact the manifest maps from a judge is one a battery produces. A question that fails the bar is inert: it yields no fact, ever.

At run time the machine emits an order whose tool is the observe activity. The activity serves governed runs only, takes only the state fields the battery declares, redacts secrets and card numbers from them, and asks Jev. Jev returns a probability per question, never text.

Each probability crosses the bands: at or above assertAt the fact is true, at or below refuteAt it is false, in between there is no fact. Out-of-range values are malformed, a vendor fault made visible, not a fact. The activity result carries the facts, the abstentions, the rounded probabilities and the model, and Temporal records it in history: on replay the workflow reads the recorded result and never calls the judge again, because Jev's answers jitter and a replay must not.

The manifest maps facts into the completion action; an absent fact arrives as null, exactly as admission explored it, so a machine that treats abstention as a yes is refused before it can run. The example refund machine refunds only when the judge cleared both questions, and otherwise routes to a person.

#### Terms used here

- **effect** — Anything a workflow does that reaches the outside world: an activity, a child workflow, a signal to another workflow, a Nexus operation. The unit the guard decides and the ledger records.
- **ledger** — One hash chain per run of proposal, verdict, effect and observation events, signed at its head by the worker's deployment key.
- **machine** — A SAM v2 state machine plus its contract, effect mapper and manifest: the certified artefact a governed run hosts.
- **work order** — What a machine step emits: an effect of a declared kind that a worker activity, an agent or a person performs and reports.
- **admission** — The CI step that checks a machine or a policy exhaustively over its declared domain and writes a signed certificate.
- **escalation** — A guard outcome that parks a call, frozen, until a person with the right role decides it.
- **Continue-as-New** — Temporal's way to start a fresh execution with a carried state, keeping history bounded; the hand-over point for versions.
- **battery** — A declared set of typed questions for the judge, each with calibrated bands that turn a probability into a fact, or into none.
- **Jev** — typesafe.ai's SystemOne judge: answers a typed question about a state with a probability, never text.
- **QuickJS** — A small JavaScript engine; compiled to WebAssembly it runs the TypeScript machine host inside Python with no host access.

### How the platform works beyond TypeScript and Temporal

**The kernel is written once in TypeScript. How does a Python worker, an OpenAI Agents SDK agent, or a LangGraph agent get the same guarantees, and what is missing there?**

Temporal's main agent story is Python, and the acquisition hedge is a second engine. Both only count if the record and the decisions are the same ones, byte for byte, not a reimplementation that drifts.

The Python port reproduces canonical JSON, the chain, the guard and redaction exactly, pinned by vectors generated from the TypeScript kernel. Its plugin governs Python workflows, including an unmodified Agents SDK agent with tools classified by route. QuickJS runs the TypeScript machine host unchanged for G2, and the LangGraph binding reuses the same kernel with a per-thread record.

[Open the diagram](beyond-ts.architecture.html) — 4 components.

| Component | Responsibility |
|---|---|
| **Python plugin** | Governs Python workflows with the same ledger and guard; classifies generic MCP tool activities by the tool they carry. |
| **Python kernel port** | Reproduces canonical JSON, the chain, the guard and redaction exactly as TypeScript does, proven by generated vectors. |
| **QuickJS machine host** *(partial)* | Runs the TypeScript machine host unchanged inside QuickJS-in-WebAssembly so Python can step a certified machine; a Python GovernedWorkflow is not built. |
| **LangGraph binding** | Governs a LangGraph agent's tool calls with the same ledger and guard, keeping the chain in a per-thread record beside the sink. |

**Deliberately not shown.** The TypeScript plugin's own path (question one), the CLI and sinks the Python ledgers verify under, and the gateway, which is TypeScript only.

#### The long read

Conformance comes first. Generators run the TypeScript kernel over canonical-JSON edge cases, guard scripts, routed policies, sealed headers, sink paths and machine step sequences, and write the results as JSON. The Python tests replay every case and require identical digests, decisions and witnesses. Where JS and Python regular expressions differ, the port matches JS.

The Python plugin governs activities, children, signals and Nexus operations through the same event shapes, seals headers the same way, and writes to sinks with the same on-disk layout, so a Python ledger verifies under the TypeScript CLI. The OpenAI Agents SDK routes every MCP tool through one activity per server, so a policy declares a route from that activity to the tool name inside its argument, and each tool is classified on its own; an undeclared routed tool is always denied.

G2 needs the machine host, and Python has no JavaScript. QuickJS compiled to WebAssembly runs the kernel's own machine-host module, sam-pattern and the machine as one script under wasmtime, with an instruction budget and no host functions at all; a corpus of 512 operations shows it stepping exactly as the TypeScript host does. What is not built is a Python GovernedWorkflow that maps orders to activities and timers.

LangGraph is not Temporal: no history, no replay. The binding hooks the ToolNode seam, decides each tool call with the same guard, and keeps the chain head and guard state in a locked per-thread record beside the sink, never in the agent's messages. A resumed thread continues one chain; a crashed step re-runs as the same effect; a thread is closed by the user, and polyflow verify --thread checks its chains as one record.

#### Terms used here

- **effect** — Anything a workflow does that reaches the outside world: an activity, a child workflow, a signal to another workflow, a Nexus operation. The unit the guard decides and the ledger records.
- **witness** — What a denial carries: the rules that fired, how to satisfy each, and the kinds allowed right now.
- **ledger** — One hash chain per run of proposal, verdict, effect and observation events, signed at its head by the worker's deployment key.
- **sink** — Where the exporter writes ledgers: a directory, memory, or the governance service.
- **machine** — A SAM v2 state machine plus its contract, effect mapper and manifest: the certified artefact a governed run hosts.
- **work order** — What a machine step emits: an effect of a declared kind that a worker activity, an agent or a person performs and reports.
- **Continue-as-New** — Temporal's way to start a fresh execution with a carried state, keeping history bounded; the hand-over point for versions.
- **QuickJS** — A small JavaScript engine; compiled to WebAssembly it runs the TypeScript machine host inside Python with no host access.
- **MCP** — Model Context Protocol: how an agent discovers and calls tools; the gateway exposes governed runs as MCP tools.

## Boundaries

A boundary is a claim about everything inside it.

### Workflow isolate

*process boundary.* Everything inside is pure, deterministic JavaScript with no I/O: it produces the same verdict on every replay of the same history

Contains: Workflow interceptor, Rule kernel, Ledger chain, Policy admission, Plan admission, Verified principals, Sealed headers, GovernedWorkflow, SAM machine host.

Crossed by:

- **Workflow interceptor → Temporal server** over event. The ledger delta on the ScheduleActivity command's header; the hand-over head on Continue-as-New. Persisted in history.
- **GovernedWorkflow → Judge activity** over in-process call. An order whose tool is polyflow.observe: the battery name and the machine state.
- **GovernedWorkflow → Temporal server** over event. The carried state, open orders, timers and claims, computed after the closing flush; AUTO_UPGRADE when the gate said so and the new version is current.

### Worker process (Node)

*process boundary.* Runs with the operator's credentials and does I/O; nothing here is replay-constrained, and nothing here can change a verdict

Contains: PolyflowPlugin, Exporter, Sinks, Judge activity, Gate workflows.

Crossed by:

- **Exporter → Service API** over https. The delta and signed head with a bearer token; back 200, 202 held back, 409 conflict or 422 refused.
- **PolyflowPlugin → Certificates** over in-process call. The machine directory and the trust store; back, the certificate, or the name of the file that differs.
- **PolyflowPlugin → Machine directory** over file. The module, contract, mapper and manifest, as string-literal requires in a generated registry the bundler resolves.
- **PolyflowPlugin → Workflow interceptor** over file. The frozen configuration (policy digest, mode, trust) as a generated module; header keys arrive through the bundler, never on disk.
- **MCP gateway → GovernedWorkflow** over grpc. polyflow.report and polyflow.claim Updates and polyflow.state queries, through the Temporal client; only for instance ids of machines the gateway offers.
- **Judge activity → Jev (typesafe.ai)** over https. Only the declared source fields, redacted, and the questions; back, a probability per question, never text.
- **Gate workflows → GovernedWorkflow** over grpc. polyflow.migrate with the from-digest, the target and a signed operator token; polyflow.wake after promotion; polyflow.guard queries for the policy ramp.
- **Gate workflows → Temporal server** over grpc. A visibility query for running governed workflows, filtered to the version being replaced.

### CI and operator tooling

*deployment boundary.* Runs before deployment and produces signed artefacts; a worker trusts only what it can verify against a public key

Contains: polyflow CLI, Admission, Structural explorer, polygraph / polyvers, Certificates, vet.

Crossed by:

- **polyflow CLI → Sinks** over file. A run's events and signed heads read from disk; a trust store of public keys.
- **polyflow CLI → Temporal server** over file. A history export; the ledger is rebuilt from the activity headers alone, unsigned.
- **Admission → SAM machine host** over in-process call. The machine module, contract, mapper and manifest, loaded fresh; the explorer steps this host.
- **Gate workflows → vet** over in-process call. The old and new directories and every distinct live state with its open order kinds; back, a decision per run.

### Governance service

*network boundary.* A separate process that holds ledgers from many workers and namespaces; it stores nothing it cannot chain, and signs nothing itself

Contains: Service API, Service store, Evidence pack.

### Python worker

*process boundary.* A byte-identical port of the kernel, pinned to TypeScript by generated conformance vectors; it never imports the TypeScript code

Contains: Python plugin, Python kernel port, QuickJS machine host, LangGraph binding.

Crossed by:

- **Python plugin → Temporal server** over event. The same polyflow-ledger header, sealed the same way; a Python ledger verifies under the TypeScript CLI.
- **QuickJS machine host → SAM machine host** over in-process call. The kernel's machine-host.mjs, sam-pattern and the machine, bundled into one script and evaluated under an instruction budget; the step semantics are the TypeScript code itself.
- **LangGraph binding → Sinks** over file. Chains named by thread, linked by continues across closes; a thread record beside them.

### Outside the platform

*trust boundary.* Nothing here is trusted: every input from it is a claim until the platform verified it

Contains: Temporal server, Customer workflow, MCP agent, Jev (typesafe.ai), Approver.

Crossed by:

- **Customer workflow → Workflow interceptor** over in-process call. The activity type and its arguments, exactly as the workflow wrote them; the interceptor is last, so it sees the final input.
- **Customer workflow → Plan admission** over in-process call. A plan of steps with dependencies and declared spend; back, admitted with escalations, refused with a witness order, or bounded.
- **Temporal server → Exporter** over event. The activity task with its headers; the exporter runs before the customer's activity code.
- **MCP agent → MCP gateway** over stdio. workflow_start, workflow_state, workflow_report, workflow_claim and the rest; arguments are type- and size-checked before anything reaches Temporal.
- **Approver → Workflow interceptor** over grpc. An approval id, a decision, the arguments digest the approver saw, and a token signed for exactly that decision.

## Components

**Customer workflow** — Runs the customer's agent loop exactly as written; it never learns that Polyflow exists except through a denial it can read.

- Source: `platform/packages/temporal/test/fixtures/agent-workflows.mjs`

**Temporal server** — Persists every workflow task, activity and header; the platform relies on it for durability and replay and adds no store of its own.

**PolyflowPlugin** — Configures a worker: generates the interceptor module, installs the exporter, registers the flush, gate and judge activities, and refuses uncertified machines.

- Source: `platform/packages/temporal/src/plugin.mjs`

**Workflow interceptor** — Turns every activity, child, signal and Nexus call into proposal, verdict, effect and observation events, and carries the ledger on activity headers.

- Source: `platform/packages/temporal/src/workflow-interceptors.mjs`

**Rule kernel** — Decides each candidate effect from the run's own history and the pinned policy, and produces a witness for every denial.

- Source: `platform/packages/kernel/src/rules.mjs`, `platform/packages/temporal/src/guard-governor.mjs`

**Policy admission** — Parses and admits a policy: every rule known, every guarded kind declared and reachable, routes validated.

- Source: `platform/packages/kernel/src/policy.mjs`, `platform/packages/kernel/src/admit-policy.mjs`

**Ledger chain** — Appends events into one hash chain per run and verifies a chain offline.

- Source: `platform/packages/kernel/src/ledger.mjs`

**Plan admission** — Checks an agent-authored plan in every execution order against the run's remaining authority before any step runs.

- Source: `platform/packages/kernel/src/plan.mjs`, `platform/packages/temporal/src/plans.mjs`

**Verified principals** — Verifies, inside the isolate, that an approval, report or claim was signed by a trusted key for that one action.

- Source: `platform/packages/kernel/src/principal.mjs`, `platform/packages/kernel/src/ed25519.mjs`

**Sealed headers** — Seals the ledger delta and the hand-over head before they reach history, because payload codecs skip headers.

- Source: `platform/packages/kernel/src/sealed-header.mjs`, `platform/packages/kernel/src/aead.mjs`

**GovernedWorkflow** — Steps a certified machine, issues its work orders as activities or external orders, answers Updates, and hands over across Continue-as-New without losing anything.

- Source: `platform/packages/temporal/src/governed-workflow.mjs`

**SAM machine host** — Fires one action against a snapshot and returns the accepted state, its orders and timers; the same code runs in admission and in QuickJS.

- Source: `platform/packages/kernel/src/machine-host.mjs`

**Machine directory** — Holds everything a machine is: descriptor, contract, SAM module, pure effect mapper, manifest, invariants, batteries.

- Source: `platform/examples/customer-brief/polyflow.workflow.json`, `platform/examples/customer-brief/effects.cjs`

**polyflow CLI** — Runs every offline check an operator or CI needs: verify a ledger, rebuild one from history, admit a policy or a machine, vet a version.

- Source: `platform/packages/cli/src/main.mjs`

**Admission** — Runs every check a machine's artefacts support and writes a signed certificate naming the exact files only if all of them pass.

- Source: `platform/packages/cli/src/admit.mjs`

**Structural explorer** — Explores the machine over its declared domain and checks liveness, state invariants, stops and that every wait has an exit.

- Source: `platform/packages/kernel/src/explore.mjs`

**polygraph / polyvers** — Checks effect invariants over every path (check-effects) and classifies a version change into compatibility lanes with validated migrations (polyvers).

**Certificates** — Digests every certified file and local module, signs and verifies certificates, and refuses a machine whose files changed.

- Source: `platform/packages/temporal/src/certificates.mjs`, `platform/packages/kernel/src/certificate.mjs`

**vet** — Decides per live run whether a new version may take it over: auto-upgrade, migrate, or pin.

- Source: `platform/packages/temporal/src/vet.mjs`

**Gate workflows** — Reads the live fleet, applies vet's decisions to each run, wakes waiting runs after promotion, and vets a policy change against guard states.

- Source: `platform/packages/temporal/src/gate-workflow.mjs`, `platform/packages/temporal/src/gate-activities.mjs`, `platform/packages/kernel/src/policy-ramp.mjs`

**Exporter** — Reads the ledger delta off an activity's header, verifies it chains from what the sink holds, signs the head it verified, and writes both.

- Source: `platform/packages/temporal/src/plugin.mjs`

**Sinks** — Holds a run's events idempotently and refuses whole any delta that conflicts or forks.

- Source: `platform/packages/temporal/src/sink.mjs`

**Service API** — Accepts deltas from many workers, verifies signed heads against namespace-bound trust, and serves runs, reports, alerts and metrics.

- Source: `platform/packages/service/src/server.mjs`

**Service store** — Stores contiguous chains, holds back out-of-order deltas, and raises conflict, fork and gap alerts.

- Source: `platform/packages/service/src/store.mjs`

**Evidence pack** — Derives compliance evidence from the ledgers a service holds, and says 'nothing in scope' rather than passing an empty period.

- Source: `platform/packages/service/src/evidence.mjs`

**MCP gateway** — Offers governed runs to any MCP agent as work orders, and turns each report into a polyflow.report Update signed for that one action.

- Source: `platform/packages/gateway/src/temporal-polyflow.mjs`, `src/mcp.mjs`

**MCP agent** — Performs the work orders a governed run offers, using whatever tools it has, and reports the outcome.

**Approver** — Answers escalations and performs human orders; with a trust store, presents a token signed for the one action.

- Source: `platform/packages/temporal/src/principals.mjs`

**Judge activity** — Sends only the battery's declared source fields, redacted, to Jev, and maps each probability through calibrated bands into a fact or no fact.

- Source: `platform/packages/temporal/src/jev.mjs`, `platform/packages/kernel/src/observe.mjs`

**Jev (typesafe.ai)** — Answers a typed question about a state with a probability; never with text.

**Python plugin** — Governs Python workflows with the same ledger and guard; classifies generic MCP tool activities by the tool they carry.

- Source: `platform/python/polyflow_temporal/plugin.py`, `platform/python/examples/openai_agents/policy.json`

**Python kernel port** — Reproduces canonical JSON, the chain, the guard and redaction exactly as TypeScript does, proven by generated vectors.

- Source: `platform/python/polyflow_temporal/rules.py`, `platform/conformance/generate-guard.mjs`

**QuickJS machine host** *(partial)* — Runs the TypeScript machine host unchanged inside QuickJS-in-WebAssembly so Python can step a certified machine; a Python GovernedWorkflow is not built.

- Source: `platform/python/polyflow_temporal/machine_host.py`, `platform/python/polyflow_temporal/quickjs_engines.py`

**LangGraph binding** — Governs a LangGraph agent's tool calls with the same ledger and guard, keeping the chain in a per-thread record beside the sink.

- Source: `platform/python/polyflow_langgraph/binding.py`, `platform/python/polyflow_langgraph/store.py`

## What moves between them

| From | To | Mechanism | What crosses |
|---|---|---|---|
| Customer workflow | Workflow interceptor | in-process call | The activity type and its arguments, exactly as the workflow wrote them; the interceptor is last, so it sees the final input. *(crosses Outside the platform)* |
| Workflow interceptor | Rule kernel | in-process call | A candidate: kind, class, labels, target and an arguments digest. Never the arguments themselves. |
| Rule kernel | Policy admission | in-process call | The policy with its digest and kinds; classification of a target, routed by an argument when the policy says so. |
| Workflow interceptor | Ledger chain | in-process call | proposal, verdict, effect and observation bodies; digests of arguments and results, redacted error text. |
| Workflow interceptor | Sealed headers | in-process call | The pending delta and the hand-over head, sealed under the worker's data key with a keyed synthetic nonce. |
| Workflow interceptor | Temporal server | event | The ledger delta on the ScheduleActivity command's header; the hand-over head on Continue-as-New. Persisted in history. *(crosses Workflow isolate)* |
| Workflow interceptor | Verified principals | in-process call | A signed token and the expected action; back, a verified id and roles, or the reason it is refused. |
| Customer workflow | Plan admission | in-process call | A plan of steps with dependencies and declared spend; back, admitted with escalations, refused with a witness order, or bounded. *(crosses Outside the platform)* |
| Plan admission | Rule kernel | in-process call | The run's current guard state, stepped through each down-set of the plan. |
| Temporal server | Exporter | event | The activity task with its headers; the exporter runs before the customer's activity code. *(crosses Outside the platform)* |
| Exporter | Sinks | in-process call | The verified delta and a head signed by the deployment key; back, what was written, skipped, or refused as a conflict. |
| Exporter | Service API | https | The delta and signed head with a bearer token; back 200, 202 held back, 409 conflict or 422 refused. *(crosses Worker process (Node))* |
| Service API | Service store | database | Events keyed by run and seq, held-back deltas with quotas, alerts, registered certificates. |
| Service API | Evidence pack | in-process call | A namespace and period; back, counts and a framework mapping with holds true, false or null. |
| polyflow CLI | Sinks | file | A run's events and signed heads read from disk; a trust store of public keys. *(crosses CI and operator tooling)* |
| polyflow CLI | Temporal server | file | A history export; the ledger is rebuilt from the activity headers alone, unsigned. *(crosses CI and operator tooling)* |
| polyflow CLI | Admission | in-process call | A machine directory and a signing key; back, a verdict per check and the certificate. |
| Admission | Structural explorer | in-process call | The host and contract; back, liveness, stop, invariant and wait findings over every reachable state. |
| Admission | SAM machine host | in-process call | The machine module, contract, mapper and manifest, loaded fresh; the explorer steps this host. *(crosses CI and operator tooling)* |
| Admission | polygraph / polyvers | in-process call | File paths of the artefacts and the depth and path limits; back, violations of effect invariants with a witness path. |
| Admission | Certificates | in-process call | Artefact digests, guarantees, checks, domains and toolchain; back, a signed certificate with a buildId. |
| Admission | Machine directory | file | The seven files, their literal-path local modules, and the certificate written back beside them. |
| PolyflowPlugin | Certificates | in-process call | The machine directory and the trust store; back, the certificate, or the name of the file that differs. *(crosses Worker process (Node))* |
| PolyflowPlugin | Machine directory | file | The module, contract, mapper and manifest, as string-literal requires in a generated registry the bundler resolves. *(crosses Worker process (Node))* |
| PolyflowPlugin | Workflow interceptor | file | The frozen configuration (policy digest, mode, trust) as a generated module; header keys arrive through the bundler, never on disk. *(crosses Worker process (Node))* |
| GovernedWorkflow | SAM machine host | in-process call | A snapshot, an action and its data; back, the accepted state, the orders and timers it emits, or a rejection with its reason. |
| GovernedWorkflow | Workflow interceptor | in-process call | Each order as an activity call (or an external order through the guard), so G2 runs are guarded and recorded like any other. |
| GovernedWorkflow | Verified principals | in-process call | The actor token on report, claim, propose, release and migrate, bound to the order, attempt and outcome. |
| MCP gateway | GovernedWorkflow | grpc | polyflow.report and polyflow.claim Updates and polyflow.state queries, through the Temporal client; only for instance ids of machines the gateway offers. *(crosses Worker process (Node))* |
| MCP agent | MCP gateway | stdio | workflow_start, workflow_state, workflow_report, workflow_claim and the rest; arguments are type- and size-checked before anything reaches Temporal. *(crosses Outside the platform)* |
| Approver | Workflow interceptor | grpc | An approval id, a decision, the arguments digest the approver saw, and a token signed for exactly that decision. *(crosses Outside the platform)* |
| GovernedWorkflow | Judge activity | in-process call | An order whose tool is polyflow.observe: the battery name and the machine state. *(crosses Workflow isolate)* |
| Judge activity | Jev (typesafe.ai) | https | Only the declared source fields, redacted, and the questions; back, a probability per question, never text. *(crosses Worker process (Node))* |
| Gate workflows | vet | in-process call | The old and new directories and every distinct live state with its open order kinds; back, a decision per run. *(crosses CI and operator tooling)* |
| vet | polygraph / polyvers | spawn | A one-state corpus per distinct state, as a child process with an argument array; back, lanes, gates and a verdict. |
| vet | Certificates | in-process call | The new directory's certificate against its files and the trust store; an unadmitted version is refused before vetting. |
| Gate workflows | GovernedWorkflow | grpc | polyflow.migrate with the from-digest, the target and a signed operator token; polyflow.wake after promotion; polyflow.guard queries for the policy ramp. *(crosses Worker process (Node))* |
| Gate workflows | Temporal server | grpc | A visibility query for running governed workflows, filtered to the version being replaced. *(crosses Worker process (Node))* |
| GovernedWorkflow | Temporal server | event | The carried state, open orders, timers and claims, computed after the closing flush; AUTO_UPGRADE when the gate said so and the new version is current. *(crosses Workflow isolate)* |
| Python plugin | Python kernel port | in-process call | Candidates and events exactly as the TypeScript interceptor produces them; the digests must match byte for byte. |
| Python plugin | Temporal server | event | The same polyflow-ledger header, sealed the same way; a Python ledger verifies under the TypeScript CLI. *(crosses Python worker)* |
| QuickJS machine host | SAM machine host | in-process call | The kernel's machine-host.mjs, sam-pattern and the machine, bundled into one script and evaluated under an instruction budget; the step semantics are the TypeScript code itself. *(crosses Python worker)* |
| LangGraph binding | Python kernel port | in-process call | Each tool call as a candidate; each decision as ledger events; the per-thread guard state. |
| LangGraph binding | Sinks | file | Chains named by thread, linked by continues across closes; a thread record beside them. *(crosses Python worker)* |

## Doctrines, guarantees and trade-offs

### Doctrines

- **Every check is a consistency check, not a proof** admission is exhaustive only over the finite domains a contract declares, and the guard decides only what its rules express
- **A denial carries a witness the agent can re-plan from** the failure names the rules that fired, what would fix each, and the kinds allowed right now; an agent that reads it stops retrying the same call
- **The certificate is the version** the buildId is a digest of what was certified, and under Worker Versioning the worker runs under that build id or not at all
- **A run never replays across versions** it hands its state to a new execution, migrated by code polyvers validated over that very state; the old and new code never share a history
- **Undeclared is denied** at guard level an activity the policy does not name is denied unless the policy says otherwise; a routed tool the policy does not name is always denied
- **A judge may answer with no fact at all** a probability between the calibrated bands is abstention, never a default false; the machine's contract decides what unknown does, typically a person

### Guarantees

- **Governance adds one billable Action per execution** the ledger rides on headers the workflow already sends; the only extra command is the closing flush. History bytes are the real cost: about 3.3x on a 10-step loop
- **A verdict is the same on every replay** the guard and the ledger are pure JavaScript with no I/O, and the isolate supplies the clock
- **Arguments and results are never recorded, only their digests** the ledger identifies what happened without becoming a second copy of the customer's data; error text is redacted and bounded
- **The Temporal history alone rebuilds the ledger** every delta is carried on an activity header, so a sink that was down loses nothing polyflow export cannot recover
- **The exporter signs only heads it verified itself** a header can claim anything; a delta for another run, another workflow, or a chain start that is not the activity's own run is refused and never signed
- **A principal token authorises one action** Temporal keeps Update arguments in history, so a token that only proved identity could be lifted and reused; binding the action makes a lifted token worthless

### Constraints

- **Payload codecs do not run on headers** the SDK visits payloads with skipHeaders, so without a worker-held data key the ledger sits in history in plaintext
- **Python has no GovernedWorkflow yet** the QuickJS host proves the sandbox and the step semantics; mapping orders to activities and timers in a Python workflow is not built

### Trade-offs

- **LangGraph gives no deterministic replay** tools can run twice and a thread has no natural end; the binding dedupes on the effect's key and the user closes the thread

### Risks

- **Open: replay-unstable event times can fork the exported chain at a hand-over (DST1-R)** the event times of a run's first activation can differ between two replays of the same history; found by the P9 review, kept visible as a todo test

