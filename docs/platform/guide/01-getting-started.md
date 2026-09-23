# Getting started with Polyflow for Temporal

Polyflow is a governance layer for agents that run on Temporal. It installs as
a worker plugin on the workflows you already have. Nothing about your
workflows, your Temporal server or your deployment changes.

This guide takes one worker from nothing to a certified, version-gated
machine, one level at a time. Each level is one change to your code, and you
can stop at any of them.

| Level | What you get | Your change |
|---|---|---|
| **G0 Observe** | A hash-chained, signed record of every effect an agent ordered | add the plugin |
| **G1 Guard** | Rules checked before each effect runs, with a witness the agent can re-plan from | add a policy |
| **G2 Govern** | A certified state machine decides *what* happens next; the agent decides *how* | host a machine |
| **G3 Certify** | Nothing runs that admission did not check; new versions are vetted against the live fleet | a CI step and a ramp gate |

Everything below runs against the Temporal dev server that the test suite
downloads. Every check here is a **consistency check, not a proof**: it is
exhaustive over the finite domains a contract declares, and nothing more.

The companion to this guide is the [reference manual](02-reference-manual.md).

## Prerequisites

- Node.js 22.13 or later, and a Temporal server (the local dev server is fine).
- A TypeScript worker using `@temporalio/worker` 1.24 or later.
- Python 3.10 or later with `temporalio` 1.33 or later, if you have Python workers.

Install and run the tests once, so you know your environment is complete:

```bash
cd platform
npm install
(cd packages/kernel && npm test)
(cd packages/temporal && node scripts/test-each.mjs)   # downloads a Temporal dev server on first run
```

## G0 — Observe: record every effect

Add the plugin to a worker. List it **last**: its interceptor must see the
final input every other plugin produced, and the worker refuses to start if
anything is registered after it.

```js
import { Worker } from '@temporalio/worker';
import { PolyflowPlugin, fileSink } from '@cognitive-fab/polyflow-temporal';

const worker = await Worker.create({
  taskQueue: 'agents',
  workflowsPath: require.resolve('./workflows'),
  activities,
  plugins: [new PolyflowPlugin({ sink: fileSink('./ledger') })],
});
await worker.run();
```

That is the whole change. From now on every activity, child workflow, signal
and Nexus operation a workflow orders becomes four events in a ledger:

```
proposal   → what was asked, with a digest of the arguments
verdict    → allowed (at G0, always)
effect     → what was scheduled, with an idempotency key
observation→ what came back: ok, or a redacted error
```

The events ride on the headers of the activities the workflow already
schedules, so **the Temporal history alone can rebuild the ledger**. A sink
that is down loses nothing. The only extra billable Action is one flush
activity per execution, which carries the closure.

### Sign the record

Without a signature, a ledger says what happened but nobody vouches for it.
Make a deployment key and give it to the worker:

```bash
npx polyflow keygen --id deployment --out ./keys
#  writes keys/deployment.key.json (private, mode 0600) and keys/trust.json (public)
```

```js
const signingKey = JSON.parse(readFileSync('./keys/deployment.key.json', 'utf-8'));
new PolyflowPlugin({ sink: fileSink('./ledger'), signingKey })
```

The exporter, an activity-side interceptor, verifies each delta's chain and
signs the head **it** verified, never a head the payload claims.

### Verify it offline

Run a workflow, then:

```bash
npx polyflow verify ./ledger/default/<workflow-id>/<run-id>.jsonl --trust ./keys/trust.json
```

```
default/my-workflow/018f… — 14 events
  chain       intact through seq 13
  signatures  3 head(s), 3 trusted and anchored, signed through seq 13
  closure     present — the record is finished
  OK — consistent, closed and signed through its last event. A consistency check, not a proof.
```

The ledger directory is named from the run: `<root>/<namespace>/<workflow-id>/<run-id>.jsonl`,
with every character outside `[A-Za-z0-9_-]` written as `~` plus two hex
digits, so `polyflow/customer-brief/2026-08-25` is the directory
`polyflow~2Fcustomer-brief~2F2026-08-25`.

If you only have a history export, rebuild the ledger from it:

```bash
temporal workflow show --workflow-id my-workflow --output json > history.json
npx polyflow export history.json --out ./rebuilt
npx polyflow verify ./rebuilt/default/my-workflow/<run>.jsonl --unsigned
```

## G1 — Guard: check rules before each effect

A policy maps the activities your workflows schedule to **effect kinds**, with
a consequence class and labels, and states rules over the sequence of those
effects. Write `policy.json`:

```json
{
  "policy": "customer-comms",
  "version": 1,
  "effects": {
    "slack_send":    { "kind": "post",     "class": "irreversible", "labels": ["egress"] },
    "ask_approval":  { "kind": "approval", "class": "none" },
    "send_email":    { "kind": "email",    "class": "irreversible", "labels": ["egress"] },
    "fetch_url":     { "kind": "fetch",    "class": "none", "labels": ["reads-untrusted"] },
    "read_crm":      { "kind": "read",     "class": "none", "labels": ["reads-private"] }
  },
  "rules": [
    { "id": "no-post-without-approval", "type": "requires-prior", "guards": "post", "prior": "approval" },
    { "id": "at-most-one-post",         "type": "at-most",        "guards": "post", "n": 1 },
    { "id": "trifecta",                 "type": "trifecta",       "outcome": "escalate" }
  ],
  "escalation": { "role": "approver", "timeoutMs": 3600000 }
}
```

Check it before you deploy it. Admission refuses a policy that guards a kind
no effect declares, or whose rules make a kind unreachable:

```bash
npx polyflow policy policy.json --out admitted.json
```

Then turn the dial:

```js
new PolyflowPlugin({ level: 'guard', policy, sink: fileSink('./ledger'), signingKey })
```

Nothing else changes. Your workflow code still calls activities. When a call
would break a rule, it fails with an `ApplicationFailure` of type
`PolyflowDenied` **before** it is scheduled, and the error carries a witness:

```js
try {
  await acts.slack_send({ text });
} catch (err) {
  if (err.cause?.type === 'PolyflowDenied') {
    const witness = err.cause.details[0];
    // witness.rules[0].fix  → "run 'approval' and wait for it to succeed before 'post'"
    // witness.allowedNow    → ['approval', 'fetch', 'read']
    await acts.ask_approval({ text });   // the agent re-plans
    await acts.slack_send({ text });
  }
}
```

At level `guard`, an activity the policy does not name is **denied** unless
you set `"unlabelled": "report"` or `"escalate"` explicitly. A guard that
allows what it does not know fails open.

### Let a person decide

The `trifecta` rule above escalates: it fires when a run has read untrusted
content *and* private data and now wants to send something out. An escalated
call parks, frozen, until someone answers:

```js
const pending = await handle.query('polyflow.pending');
// [{ approvalId: 'ap-p7', kind: 'email', target: 'send_email', args: [...], rules: ['trifecta'], role: 'approver', … }]
await handle.executeUpdate('polyflow.approve', {
  args: [{ approvalId: pending[0].approvalId, decision: 'approve', principal: 'alice', argsDigest: pending[0].argsDigest }],
});
```

The approver sees the exact arguments and approves exactly those: the parked
call is a frozen copy, so the workflow cannot edit it while it waits. With no
answer inside `escalation.timeoutMs`, the call is denied.

Until you configure verified principals (below), `principal: 'alice'` is a
claim and is recorded as `verified: false`.

### Prove who approved: verified principals

Give the worker the public keys of whoever may act, and every approval,
report and claim must carry a token signed by one of them, for **that one
action**:

```js
new PolyflowPlugin({ level: 'guard', policy, sink, signingKey,
  principals: { 'idp': idpPublicKeyPem },   // keyId -> ed25519 public key
});
```

Mint tokens where people are authenticated (your identity bridge, an
approvals console), never in the workflow:

```js
import { signPrincipal } from '@cognitive-fab/polyflow-temporal';

const token = signPrincipal(
  { id: 'alice', roles: ['approver'], aud: 'default',
    act: { op: 'approve', wf: workflowId, run: runId, ref: approvalId, decision: 'approve', argsDigest } },
  idpKey,                       // { keyId: 'idp', privateKeyPem }
  { ttlMs: 5 * 60_000 },
);
await handle.executeUpdate('polyflow.approve', { args: [{ approvalId, decision: 'approve', principal: token }] });
```

The workflow verifies the signature itself, in pure JavaScript inside the
isolate. A token lifted from history authorises nothing but the action it
already recorded.

### Seal the record in history

Temporal's payload codecs do not run on headers, so at G0 and G1 the ledger
sits in history as the codec sees the rest of the payload: plaintext. If that
matters to you, give the worker a data key:

```js
new PolyflowPlugin({ level: 'guard', policy, sink, signingKey,
  headerKey: { keyId: 'dk-2026-09', key: base64Of32RandomBytes },
});
```

Headers are then sealed with ChaCha20-Poly1305 before they reach history, and
the exporter refuses a plaintext one. The key is injected into the in-memory
bundle at worker start and never written to disk. `polyflow export` needs the
same key: `--header-keys keys.json`.

## G2 — Govern: a certified machine decides what happens next

At G2 the agent no longer drives the sequence. A **SAM v2 state machine**
does: each accepted step emits *work orders*, and the agent, a worker
activity, or a person performs each order and reports back. The machine
decides what may happen next; the performer decides how.

A machine is a directory. `platform/examples/customer-brief` is the reference:

```
customer-brief/
  polyflow.workflow.json    the descriptor: name, tools, key, stop action
  contract.json             state keys, actions, their data domains, terminal states
  machine.cjs               the SAM v2 module: actions and acceptors
  effects.cjs               the pure mapper: (pre, action, data, post) -> orders and timers
  effects.manifest.json     each order kind: what completes it, retries
  effect-invariants.mjs     what may never be emitted on any path
  invariants.mjs            what must hold in every reachable state
```

The daily brief: fetch tickets, draft, ask a person, post once.

```js
// effects.cjs — the only place effects are decided, and it is pure
module.exports.effects = (pre, action, data, post) => {
  const out = [];
  const entered = (s) => pre.briefState !== s && post.briefState === s;
  if (entered('gathering')) out.push({ kind: 'fetch_tickets', payload: { window: 'yesterday' } });
  if (entered('drafting'))  out.push({ kind: 'draft_brief',   payload: { ticketCount: post.ticketCount } });
  if (entered('review')) {
    out.push({ kind: 'request_approval', payload: { ticketCount: post.ticketCount } });
    out.push({ kind: 'timer', key: 'approvalWindow', fireInMs: 8 * 3600_000, action: 'DENIED', data: { reason: 'not-ready' } });
  }
  if (entered('posting'))   out.push({ kind: 'post_brief',    payload: { ticketCount: post.ticketCount } });
  return out;
};
```

Host it. Your workflows module re-exports the governed host, and the worker
names the machine:

```js
// workflows.mjs
export * from '@cognitive-fab/polyflow-temporal/workflows';
```

```js
new PolyflowPlugin({
  sink, signingKey,
  machines: { 'customer-brief': './machines/customer-brief' },
  allowUncertified: true,          // development only; see G3
});
```

Each order kind is an activity of the same name (`fetch_tickets`,
`draft_brief`, …), or the activity the descriptor's `tools[kind].activity`
names. Start a run from the input the descriptor's key template needs:

```js
import { startGoverned, loadMachineDir } from '@cognitive-fab/polyflow-temporal';

const { descriptor } = loadMachineDir('./machines/customer-brief');
const run = await startGoverned(client, { descriptor, input: { date: '2026-09-23' }, taskQueue: 'agents' });
// run.workflowId === 'polyflow/customer-brief/2026-09-23'; run.status === 'started' | 'attached' | 'complete'
```

The workflow id is derived from the input, so a second start of the same
brief **attaches** to the first run instead of posting twice. Watch it:

```js
await handle.query('polyflow.state');
// { state: { briefState: 'review', ticketCount: 3, reason: '' }, seq: 3,
//   orders: [{ orderId: '…', kind: 'request_approval', role: 'human', … }], terminal: false, … }
await handle.query('polyflow.journal');   // every step: accepted, rejected, unhandled, with pre and post state
```

### Let agents and people perform the orders

With `externalMode: 'allowed'` (or `'always'`), orders are not activities:
they wait for whoever holds the tools. The MCP gateway exposes the run to any
MCP-capable agent with six tools that never change (`workflow_list`,
`workflow_start`, `workflow_report`, `workflow_state`, `workflow_signal`,
`workflow_journal`) plus `workflow_claim`:

```bash
POLYFLOW_MACHINES='{"customer-brief":"./machines/customer-brief"}' \
POLYFLOW_TRUST=./keys/trust.json \
POLYFLOW_ACTOR='{"id":"desk-agent","roles":["agent"]}' \
npx polyflow-gateway
```

An order addressed to a person (`"performer": "human"`) is reported only by
an actor holding the `human` role. An order one agent has claimed is reported
only by that agent until its lease lapses.

### Ask a calibrated judge

A machine can order a *judgement* instead of a tool call. `refund-triage`
asks Jev two questions about a customer message and receives facts, or no
fact at all:

```json
"reason_stated": {
  "type": "noul",
  "instructions": "Does the customer's message state a concrete reason for the refund?",
  "assertAt": 0.85, "refuteAt": 0.15,
  "calibration": { "n": 120, "positives": 58, "negatives": 62, "assertPrecision": 0.97, "refutePrecision": 0.95, "model": "jev-2026-06" }
}
```

A probability above `assertAt` is the fact `true`; below `refuteAt` it is
`false`; in between there is **no fact**, and the machine's contract says what
"unknown" does (in the example: a person decides). A question whose
calibration does not meet the bar is inert. Configure the worker with
`jev: { key: process.env.TYPESAFE_API_KEY }`, and only the state fields the
battery declares as `source` leave the machine, redacted.

## G3 — Certify: nothing runs that was not checked

### Admit the machine in CI

```bash
npx polyflow admit ./machines/customer-brief --key ./keys/ci.key.json
```

```
  ✔ domain
  ✔ check-effects  paths 41, states 9
  ✔ structural  every-state-can-finish:ok state-invariants:ok waits-on-people-arm-timers:ok stop-from-every-state:ok every-wait-has-an-exit:ok order-waits-have-deadlines:not checked no-poisoned-steps:ok
  ADMITTED customer-brief as cert-3f9a1c2b7d4e (signed by ci)
  guarantees: at-most-one-post-per-path, no-post-without-prior-approval, …
  exhaustive over the declared domains only. A consistency check, not a proof.
```

Admission explores every path over the contract's declared domain and
refuses a machine that:

- can emit something an effect invariant forbids (a second post; a post with no prior approval);
- has a state that cannot finish, or a wait that no order outcome or timer can end;
- has no stop action a person can use from every state (states declared `unstoppable` need a reason);
- reads a fact from a judge battery that does not produce it;
- requires code that is not a literal, certified file.

The certificate names every file, every local module and the SAM library
version. Now drop `allowUncertified` and give the worker the trust store:

```js
new PolyflowPlugin({ sink, signingKey, machines: { 'customer-brief': dir }, trust })
```

A worker refuses a machine whose files differ from its certificate by one
byte, naming the file. Under Worker Versioning, **the certificate's build id
is the deployment version**:

```js
workerDeploymentOptions: { useWorkerVersioning: true, version: { deploymentName: 'brief', buildId: plugin.buildId() }, defaultVersioningBehavior: 'PINNED' }
```

### Gate a new version against the live fleet

You change the machine (v2 adds `CANCEL`). Before promoting v2:

```bash
npx polyflow admit ./machines/customer-brief-v2 --key ./keys/ci.key.json
npx polyflow vet --old ./machines/customer-brief --new ./machines/customer-brief-v2 --fleet fleet.json --trust ./keys/trust.json
```

`vet` runs polyvers over every distinct live state and decides per run:
`auto-upgrade`, `migrate` (with the migrated state), or `pin`. Or let the
gate workflow do it against the running fleet, in three phases:

```js
// 1. before promotion: vet, and tell each run that moves to wait
await client.workflow.execute('PolyflowGateWorkflow', { taskQueue, workflowId: 'gate-v2',
  args: [{ machine: 'customer-brief', oldDir, newDir, toBuildId: v2.buildId(), fromBuildId: v1.buildId(), onVersionChange: true }] });
// 2. promote v2 (Worker Controller, or setWorkerDeploymentCurrentVersion)
// 3. wake the waiting runs: each continues as new onto v2, carrying its state and open orders
await client.workflow.execute('PolyflowGateWorkflow', { taskQueue, workflowId: 'gate-v2-wake',
  args: [{ machine: 'customer-brief', phase: 'wake' }] });
```

A run never replays across versions. It hands its state to a new execution,
migrated by the `migrate.cjs` that polyvers validated over that very state.
The gate fails, and nothing is promoted, if any run would have to be pinned.

For G1 workflows, `PolyflowPolicyGateWorkflow` does the same for a policy
change: it reads every running workflow's guard state and refuses the ramp if
the new policy would deny a run something it may do now.

## Python workers

The Python plugin covers G0 and G1 with a kernel that is byte-identical to
the TypeScript one (pinned by `platform/conformance`):

```python
from temporalio.worker import Worker
from polyflow_temporal import PolyflowPlugin, FileSink

worker = Worker(client, task_queue="agents", workflows=[...], activities=[...],
                plugins=[PolyflowPlugin(level="guard", policy=admitted, sink=FileSink("./ledger"), signing_key=key)])
```

`admitted` is the JSON `polyflow policy` printed. Set `"unlabelled": "deny"`
in it yourself: Python does not fill in the guard-level default. A Python
ledger verifies under the TypeScript CLI.

**An unmodified OpenAI Agents SDK agent** runs under this plugin. The SDK
routes every MCP tool through one activity per server, so the policy
classifies by the tool the call carries:

```json
"routes": { "Tickets-stateless-call-tool-v2": "0.tool_name" },
"effects": {
  "invoke_model_activity": { "kind": "model" },
  "Tickets-stateless-list-tools": { "kind": "discover" },
  "Tickets-stateless-call-tool-v2:read_ticket":  { "kind": "read" },
  "Tickets-stateless-call-tool-v2:issue_refund": { "kind": "refund", "class": "irreversible" }
}
```

See `platform/python/examples/openai_agents/`. A routed call whose tool the
policy does not name is always denied.

## Without Temporal: LangGraph

The same ledger and the same guard, at G0 and G1, for a LangGraph agent:

```python
from langgraph.prebuilt import create_react_agent
from polyflow_langgraph import govern
from polyflow_temporal.sinks import FileSink

tools = govern([read_ticket, issue_refund], level="guard", policy=admitted, sink=FileSink("./ledger"), signing_key=key)
agent = create_react_agent(model, tools, checkpointer=saver)
agent.invoke({"messages": [("user", "refund T1")]}, {"configurable": {"thread_id": "t-1"}})
tools.governor.close({"configurable": {"thread_id": "t-1"}})
```

A conversation is one chain, kept in a per-thread record beside the ledger.
It survives a checkpoint resume in another process. What LangGraph cannot
give you is deterministic replay: tools can run twice, and a thread has no
natural end, so you close it. `polyflow verify --thread <dir>` checks a
thread's chains as one record.

## Where to go next

- The [reference manual](02-reference-manual.md): every option, file, rule
  type, query, Update, command and endpoint.
- The [governance service](02-reference-manual.md#7-the-governance-service):
  a shared sink with tamper alerts, metrics and an evidence pack mapped to the
  EU AI Act, ISO/IEC 42001 and NIST AI RMF.
- The [acquisition brief](../04-acquisition-brief.md) for what is measured,
  and what is still open.
