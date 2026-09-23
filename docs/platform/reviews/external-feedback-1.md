# External feedback 1: plan and pitch

Source: a read of documents 00 to 03 and the P0/P1 review, checked against
`platform/`. Each point is listed with what we did about it. "Plan" means a
row was added to `03-implementation-plan.md`.

## 1. Positioning: a single buyer

| Point | Disposition |
|---|---|
| Governance on Temporal has one buyer, and Temporal's Agent Harness (tool approvals) and OpenBox are already in that slot. | **Accepted as a risk.** Governance on Temporal stays the thesis, because the stated goal is that Temporal's customers can adopt it as it is and that Temporal acquires it. The Harness overlap is handled by FR-AGT.6: we plug in behind the Harness as its policy predicate. The Harness ships approvals. We add checked rules, witnesses, a verifiable record and fleet-gated versions. |
| Hedge: add a thin second binding at G0/G1 (Restate, DBOS or LangGraph). The kernel is already engine-neutral. | **Plan (P10, optional).** A second binding covering the ledger and guard only, with no G2 or G3. The kernel needs no change. The Python kernel port already proves it is portable. The binding is scheduled after P9 so that it does not dilute the Temporal story before diligence. This is a decision for the owner (see the conversation). |
| If polyrun was meant as the standalone alternative, the plan keeps it out of the product. | **Correct, and deliberate.** polyrun stays in polygraph as the reference engine. Governed runs on Temporal behave like polyrun, which is the conformance baseline. |

## 2. Order and focus

| Point | Disposition |
|---|---|
| Python arrives too late (P7). | **Already done out of order.** The Python kernel and the G0/G1 plugin are built. They are byte-identical to TypeScript on the conformance corpus, and a Python ledger verifies under the TypeScript CLI. Still open: the OpenAI Agents SDK sample (7.3). It is moved up to the next step (see §3). |
| Fleet-gated versioning works only for G2 (rewritten workflows). | **Accepted, and now stated plainly** in the spec: D5 covers G2 runs only. **Plan (P4.6): policy ramp gating at G1.** A policy change is vetted against the guard states of in-flight runs before workers carrying it are promoted. That is the G1-level version: it asks whether a run in flight would be denied an effect it has already been promised. The guard state is already carried and queryable. |
| There are 11 differentiators. Lead with D1 (admission), D4 (ledger) and D5 (versioning), and cut P8 to the offline verifier. | **Accepted for the pitch.** The acquisition brief (P9) leads with those three. P8's Postgres store, inbox UI and Nexus facade are marked *post-acquisition-brief*. The service that exists stays, because it is small and it is where the evidence pack lives. |

## 3. Technical risks

| Point | Disposition |
|---|---|
| The OpenAI Agents SDK may route every MCP tool through one generic activity, with the tool name only in the arguments. The guard keys on `activityType`. | **Plan (P7.3a spike, next).** The guard's classifier gains `classifyBy`: a policy may classify an activity by a named argument path, such as the tool name inside a generic tool activity. FR-AGT.1 does not promise "unmodified" until the spike confirms the SDK's activity shape. |
| Approvals bound to argument digests are brittle with LLMs. | **Clarified. The implementation already freezes the arguments.** An escalation parks the *scheduled call itself*, so an approval releases exactly the arguments the approver saw, and a rewrite by the model is a new call that needs a new approval. That is the point. The brittle case is a *pre-approval* (FR-GRD approval tokens) for a call made later. For that case the approval request will carry the frozen arguments, and the effect will be required to execute those (**plan P5.6**). |
| `node:vm` is not a security boundary. | **The spec was wrong about the code.** Plans are **declarative JSON** (`parsePlan`), not code. No agent-written code is evaluated anywhere, and `node:vm` is not used. The spec now says so. If code-bearing plans are ever added, they go to QuickJS-Wasm (P0.6), never to `node:vm`. |
| Deferring M3 conflicts with NFR-7. Ledger headers bypass the customer's codec. | **Accepted, and moved before any pilot (plan P2.6).** Until then the headers carry digests and redacted, truncated error text, and no argument or result values. Header bodies go through the worker's payload codec, applied on the activity side by the exporter. |
| NFR-13 misses billed heartbeats on external-agent orders and history bytes against the 50 MB cap. | **Plan (P9).** Both are added to the overhead measurement. The P6–P8 review also found that the published 4.5% figure used `memo: false`. The default is 9.1% on the same loop. NFR-13 will report both. |
| Every policy change is a redeploy and a ramp. | **Stated outright** in the technical spec (§3.2): a policy is part of the worker build, on purpose. It is then versioned, certified and ramped like code, and P4.6 gates that ramp. |

## 4. Wording and process

| Point | Disposition |
|---|---|
| "Provably allowed" contradicts "a consistency check, not a proof". | **Fixed:** the text now reads "checkably allowed" everywhere. |
| Nothing is committed. | **Waiting for the owner.** Commits are made only when the owner asks. |
| The Status section is empty, and phases were built while their review was open. | The Status table is filled in. The overlap is real: P2 was built while P0/P1 was under review. The rule now applies as written. No phase is marked done until its review is answered. The P4/P5 review is answered. The P6–P8 review is open, and its findings come next. |
| Numbering: FR-AGT.6 before .5, NFR-12 after NFR-14. | **Fixed.** |
