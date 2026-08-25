# polyflow

**An agent can already resume a parked run. It cannot tell you what the resumed run is allowed to do.**

polyflow is a workflow engine for AI agents. The agent reasons *a workflow*
instead of *the next tool call*; polyflow admits that workflow only if it
model-checks, then runs it durably and hands the agent one work order at a
time.

It ships as an MCP server, so any MCP-capable agent — OpenWorker, Claude Code,
Cursor — can use it with no changes to that agent's core.

> Experimental, unproven, not peer-reviewed. The check is a **consistency
> check, not a proof**, and "exhaustive" always means exhaustive over the
> finite domain the contract declares. Every finding is a lead, not a result.

## The loop

```
tools → observe → reason → WORKFLOW ──▶ polyflow admits it (or refuses)
                                            │
                        ┌───────────────────┘
                        ▼
        one work order  →  the agent runs the tool, through its own
                           permission gates, with its own credentials
                        →  workflow_report
                        →  next work order … until terminal
```

The agent never decides what comes next. It reasons about *how* to fulfil one
order — which is what a model is actually good at — and reports the result.
Sequencing, retries, timers, duplicate suppression and terminal conditions
belong to the machine.

## Why this and not a standing grant

Today an unattended automation gets approved by *verb*: "allow `slack_send` to
`#cs`", forever, for whatever the model decides to do with it. That is the
ceiling when the plan is a prose instruction string re-planned on every run.

polyflow approves a *plan*. `workflows/customer-brief/effect-invariants.mjs`
holds the sentences a user can actually agree to:

```js
{ name: 'no-post-without-prior-approval',
  pred: (path) => path.emitted.every((e, i) =>
    e.kind !== 'post_brief' || path.actionBefore('APPROVED', i)) }
```

Startup enumerates every reachable emission path over the contract's declared
domain and checks them. A workflow that fails is **not registered** — not
flagged, unrunnable:

```
[polyflow] admitted: customer-brief — paths explored: 5 · states seen: 10 · exhaustive within declared domains
[polyflow] REFUSED: unsafe-brief
[polyflow]   no-post-without-prior-approval
```

`test/fixtures/unsafe-brief` is the deliberately broken twin: it posts on
entering review, before the human answers. It still calls `ask_user`, still
targets the same channel, still satisfies the standing grant. A reviewer
reading the diff could easily miss it. The gate does not.

## Quickstart

```bash
npm install
npm test                       # 11 tests, no API key, deterministic
node bin/polyflow-mcp.mjs      # MCP stdio server
```

polyflow embeds [polyrun](https://github.com/cognitive-fab/polygraph) in
process. Point `POLYFLOW_POLYRUN` at your polygraph checkout if it is not a
sibling directory.

Register with an MCP-capable agent:

```json
{ "mcpServers": { "polyflow": {
    "command": "node",
    "args": ["/path/to/polyflow/bin/polyflow-mcp.mjs"],
    "env": { "POLYFLOW_AGENT": "openworker/cowork", "POLYFLOW_INSTANCE": "acme" } } } }
```

| env | meaning | default |
|---|---|---|
| `POLYFLOW_WORKFLOWS` | workflow library directory | `./workflows` |
| `POLYFLOW_DB` | sqlite path | `.polyflow/polyflow.sqlite` |
| `POLYFLOW_AGENT` | agent-class area | `default` |
| `POLYFLOW_INSTANCE` | instance area (workspace) | cwd basename |
| `POLYFLOW_POLYRUN` | polygraph checkout | `../polygraph` |

## Tools

| tool | does |
|---|---|
| `workflow_list` | what this agent knows how to do, and the guarantees each was admitted under |
| `workflow_start` | start **or re-attach** — same key, same run, so a nightly task resumes instead of restarting |
| `workflow_report` | report a tool result, receive the next order |
| `workflow_state` | state + open orders, changes nothing |
| `workflow_signal` | an out-of-band event; an action that does not apply is an observable reject |
| `workflow_journal` | every step, accepted or rejected, with its reason — also a valid Polygraph trace corpus |

## Areas

Two tiers, and they need no new fields in OpenWorker:

- **agent area** — one per agent *class* (`openworker/cowork`). Owns the
  workflow library: what this kind of agent knows how to do. Maps to
  `ScheduledTask.agent`.
- **instance area** — one per running *copy* (`workspace`). Owns the live runs
  and their journals. Maps to `workspace`, which is already
  `coworker.memory.Scope.WORKSPACE`.

The instance id is derived from `agent | instance | workflow | key`, which is
why start and attach are one call.

## A workflow

Six files in a directory:

```
polyflow.workflow.json   name, area, tools{effect kind -> agent tool}
contract.json            states, actions, finite data domain
machine.cjs              SAM v2 strict-profile module
effects.cjs              pure mapper: transition -> work orders
effects.manifest.json    completion actions + retry policy per kind
effect-invariants.mjs    what may be EMITTED, on every reachable path
```

The inversion that makes this work for agents: in polyrun the runtime executes
effects. polyflow has no credentials, no connectors and no permission engine —
the agent has all three. So an effect is a **work order handed back**. The
handler parks; the agent claims the order, runs the tool under its own gates,
and reports. Only then does the completion action dispatch.

Durability falls out of the lease machinery. The pending map is in-memory, so a
crash loses the promise, the lease expires, the effect is re-claimed and the
order is re-offered — same intent id, at-least-once, absorbed by the machine.

## What the tests prove

```
✔ the admission gate certifies the demo workflow exhaustively
✔ workflow_list reports the guarantees the run was admitted under
✔ happy path: one order at a time, ending posted
✔ start is idempotent: re-attaching returns the run in progress
✔ a denial is a result, not a fault — and no post is ever ordered
✔ zero tickets ends the run rather than posting an empty brief
✔ a duplicate report is refused, not double-executed
✔ an out-of-band action that does not apply is an observable reject
✔ a workflow that can post before approval is REFUSED and cannot be started
✔ a run outlives the process: restart re-offers the open work order
✔ initialize, tools/list, tools/call over stdio
```

The restart test is the one that matters: session 1 drives the run to the
approval step and dies; session 2 is a different process with no conversation,
no transcript and no replay — because the state was never in the messages to
begin with. It picks the run up exactly where it was, and exactly one post
happens across both.

## Not built yet

- **Promotion.** Workflows are hand-authored here. The plan is to mine
  recurring run shapes out of journals and propose a machine for review —
  induction from history, not foresight. Authoring a machine per task costs
  more than the tool calls it replaces unless it is reused.
- **Versioning.** polyvers gates a changed workflow against in-flight runs;
  not wired in.
- **Audit.** The journal is already a trace corpus; `polyrun audit` against it
  is not wired in.
- **The OpenWorker seams that need core changes:** routing a parked order to
  the Inbox, and `workflow_ref` on `ScheduledTask`. See `FINDINGS-phase0.md`.
