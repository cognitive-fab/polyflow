# Polyflow for Temporal: a brief for Temporal's AI team

**Temporal makes an agent's work survive a crash. Polyflow makes it checkably
allowed.**

Polyflow is a governance layer that installs as a worker plugin on the
workflows a Temporal customer already runs. It needs no new engine, no second
database and no fork. It builds on interceptors, Updates, Worker Versioning
and the Replayer. Two of the seams it uses are still marked `@experimental` in
TypeScript SDK 1.24: the worker **plugin** interface and **Upgrade-on-Continue-as-New**
(`initialVersioningBehavior`). This brief sets out three capabilities,
the evidence behind each, the open work, and why the layer belongs inside
Temporal.

Every check below is a **consistency check, not a proof**. It is exhaustive
over the finite domains a contract declares, and over nothing else.

---

## The problem, in Temporal's own terms

Temporal guarantees that a workflow's code runs to completion, exactly as
written, across crashes. An agent's workflow is written *by the model at run
time*: which tool, with what arguments, in what order. Durability makes that
code survive. It does not make it allowed.

The failures that stop agent deployments are therefore not crashes. An agent
posts twice. It posts before anyone approved. It reads private data and
mails it out. It spends past its budget. It ships a version that strands the
runs already in flight. Customers solve these today with ad-hoc guards inside
activities, which are invisible to audit and differ from team to team.

## Three capabilities

### 1. Admission: nothing runs that was not checked (D1)

`polyflow admit` explores a machine over its contract's whole declared domain
and writes a certificate. The certificate names every file, every local module
and the SAM library version it checked. The worker refuses a machine whose
files differ from the certificate, and under Worker Versioning **the
certificate's build id is the deployment version**.

Admission checks:

- **Effect invariants**, over every path. Example: "no refund unless the judge
  cleared it or a person approved".
- **Domain coverage.** A certificate cannot name a domain nobody explored.
- **State invariants.**
- **Liveness.** Every state can finish, and every outcome of every order
  open in a state is one that state accepts. A failure it refuses would
  strand the run. This check found such a gap in our own example.
- **Stop.** A person can stop the run from every state, except states declared
  unstoppable with a reason.
- **Judge batteries** (Jev).

**Evidence:**

- `packages/cli/test/admit.test.mjs` and the three review suites.
- Two plausible bugs in a judge-driven refund machine: reading an abstention
  as "no fraud", and refunding when the judge refuted the reason. The P6–P8
  review found both certified. Both are now refused (JA1, JA2).

### 2. The decision ledger, carried by Temporal itself (D4, with D2 and D6)

Every effect a workflow orders becomes four events in a hash chain:
proposal → verdict → effect → observation. The chain rides on the activity
headers the workflow already schedules. So **history alone rebuilds it**
(`polyflow export`), and a sink outage loses nothing.

At G1 the same interceptor runs the rule kernel, which is pure and replays
exactly:

- sequence rules;
- budgets, including metered ones;
- rate limits;
- the lethal trifecta.

A denial carries a witness the agent can re-plan from. An escalation parks a
frozen copy of the call. The approver sees its arguments and approves those,
and the copy is what runs, even if the workflow edits its own objects while
the call waits. With a trust
store, the approver's identity is a signed token the workflow verifies itself,
in pure JavaScript inside the isolate. With a data key, the headers are sealed
before they reach history, because Temporal's payload codecs skip headers.

**Evidence:**

- **pass^k.** The same scripted stochastic agent (8 tasks × 4 trials,
  `passk.test.mjs`), plain and under G1, where success means posted exactly
  once, after approval:

  | | pass^1 | pass^4 | unsafe trials | missed |
  |---|---|---|---|---|
  | plain | 0.50 | 0.00 | 16 | 0 |
  | G1 | 0.81 | 0.63 | **0** | 6 |

  **What this does and does not show.** There is one task and 32 seeded trials,
  and each trial's outcome is a function of its seed. "0 unsafe" is what the
  policy is for. The evidence is that the plugin enforces it end to end on a
  real server with unmodified agent code. The plain arm's pass^4 of 0.00 is
  small-sample: its expectation at these rates is about 0.14. The guard cannot
  make an agent ask for an approval it forgot, so those trials post nothing
  instead of posting unapproved.
- **DST** (`dst.test.mjs`). 20 seeded schedules drive governed runs:
  - reports that succeed, fail or arrive twice;
  - claims by two agents, and reports by the wrong one;
  - STOP;
  - forced Continue-as-New, and stale migrations.

  After every schedule:
  - the last execution's journal shows at most one post;
  - the state is one the machine can hold;
  - every execution replays with zero non-determinism.

  The stimuli are sequential. The harness's own review found two defects:
  - An Update accepted during a hand-over was lost. This is fixed: Updates are
    now refused with a retryable reason until the next execution runs.
  - Event times in a run's first activation can differ between two replays of
    the same history, which forks the exported chain at the hand-over. This is
    **open**, and the test that shows it is kept visible.
- **The OpenAI Agents SDK.** An **unmodified** agent runs under G1 in Python.
  MCP tools that the SDK routes through one generic activity are classified
  by tool name. The ledger records model calls and each tool, the guard
  denies the second refund, and the Python ledger verifies under the
  TypeScript CLI (`python/tests/test_s2_openai_agents.py`).
- **Cost.** One billable Action per execution, the closing flush: 4.5% on a
  22-Action loop, and under 10% from 11 Actions. These are counted as
  docs.temporal.io/cloud/actions counts them: a memo upsert is not billed, and
  queries and rejected Updates are billed but not added by governance.
  **History size is the real cost.** The ledger headers make the history of
  that loop 3.3× larger (4.2× sealed), about 4 KB per activity, measured as
  protobuf.

### 3. Fleet-gated versioning on Worker Versioning (D5, and P4.6 at G1)

For a governed run (G2), `PolyflowGateWorkflow` works in three steps:

1. It vets the new version against the live state of every run on the old
   one, using polyvers, before promotion. A run moves, with a migrated state
   if needed, or it is pinned.
2. The runs that move wait, pinned to the old version.
3. After promotion, a wake phase lets each run **Continue-as-New onto the new
   version** (Upgrade-on-Continue-as-New). It carries its state, its open
   orders, its claims and its guard.

A run never replays across versions. A migration is bound to the state it
was computed from. If the run has since moved on, the migration is dropped at
the hand-over and the gate re-vets. With verified principals, the gate's
signature also binds the run and the target state. If Temporal suggests
Continue-as-New while a run waits for promotion, the run stays on its version
and keeps waiting.

For an ordinary workflow (G1), `PolyflowPolicyGateWorkflow` reads each running
workflow's guard state by query, before a policy change ramps. It compares
**activities**, not kind names, including undeclared ones, and carries spent
budgets across renamed rules. It names every run the new policy would deny
something it may do now. It fails closed on:
- a run it cannot read;
- an empty fleet.

"Pinned" means the gate refuses the ramp. Keeping those runs on the old
workers is the operator's Worker Versioning decision.

**Evidence:**

- `versioning.test.mjs`. Two certified, signed versions run on two deployment
  versions. The gate runs before promotion, and the run does not move until
  promotion and wake. The next execution reports v2's build id, with its state
  and open order carried. v2's new CANCEL is accepted on a run that started
  under v1.
- `policy-ramp.test.mjs`.

---

## How it was built: phases interleaved with adversarial reviews

The work ran in phases, and each phase was followed by an independent
adversarial review that wrote failing tests before any fix:

- [`P0–P1`](reviews/P0-P1-review.md)
- [`P2–P3`](reviews/P2-P3-review.md)
- [`P4–P5`](reviews/P4-P5-review.md)
- [`P6–P8`](reviews/P6-P8-review.md)
- the P9 security review and licence audit

Across the first four reviews, 12 blockers and 59 majors were found. Every
review has a written response in which each finding is marked fixed,
narrowed, or deferred with a reason. The P9 security review and the P9 review
added 6 blockers and 28 majors, answered the same way. One major is still
open: DST1-R. The reviews are part of the deliverable. They show where the
design was wrong, and how it was corrected.

## What is open

The following are said plainly, so diligence does not have to find them:

- **S3 with a real model.** The FINDINGS-phase3 double-post study has not been
  replicated on Temporal with a live model. The S3 test is the re-fire
  mechanism, scripted. The pass^k agent is a seeded script.
- **History size.** The ledger headers make the history of a 10-step loop
  3.3× larger (4.2× sealed), measured as protobuf. A compact header encoding is
  the next cost item. G2's half of NFR-13 is unmeasured.
- **DST1-R.** Replay-unstable event times in a run's first activation fork the
  exported chain at a Continue-as-New. It was found by the P9 review's DST test,
  which is kept visible as a todo.
- **G2 in Python.** It needs a sandboxed JS evaluator (QuickJS). See the P7.4
  spike.
- **Deferred until after this brief:** a Postgres store, an approvals inbox UI,
  a policy catalogue service, a Nexus facade, and a `PolyflowCertificate`
  search attribute.
- **Plan children.** Plans run inside the parent under the parent's guard,
  which is how the authority ceiling holds. Separate child workflows are not
  built.

## Why inside Temporal

- **It is additive.** One plugin line. The same workflows. The same Worker
  Versioning. The same Replayer. The two `@experimental` seams it uses (the
  plugin interface and Upgrade-on-Continue-as-New) are Temporal's own. A Temporal customer adopts it at
  G0 with no behaviour change and turns the dial one level at a time.
- **It fits the Agent Harness.** The rule kernel is the policy predicate the
  Harness's tool-approval layer asks. The Harness supplies approvals, and
  Polyflow adds checked rules, witnesses, a verifiable record and gated
  versions.
- **It is engine-neutral underneath.** The kernel is pure and has a
  byte-identical Python port pinned by conformance vectors. That keeps
  Temporal's TypeScript and Python SDK stories identical.
- **Licence.** Source-available. The plugin, the governed host, the gates,
  the CLI, the gateway, the service and the Python package are BUSL 1.1
  (production use inside one's own organisation is granted; each version
  converts to Apache-2.0 after four years). The kernel and the verifier are
  Apache-2.0, so a record is checkable by anyone, Temporal included, with no
  licence conversation. An acquirer takes the copyright and the BUSL
  exclusivity; nothing under Apache-2.0 is ever relicensed. See
  [`platform/LICENSING.md`](../../platform/LICENSING.md) and the audit in
  [`reviews/P9-licence-audit.md`](reviews/P9-licence-audit.md).

## Reproduce

```bash
cd platform && npm install
(cd packages/kernel && npm test)
(cd packages/cli && npm test)
(cd packages/temporal && node scripts/test-each.mjs)   # dev server; DST, pass^k, versioning included
(cd packages/gateway && npm test)
(cd packages/service && npm test)
(cd python && .venv/Scripts/python -m pytest -q)       # includes the OpenAI Agents SDK sample
```
