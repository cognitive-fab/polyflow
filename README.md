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
npm install                    # pulls polygraph (polyrun) as a dependency
npm test                       # 14 tests, no API key, deterministic
node bin/polyflow-mcp.mjs      # MCP stdio server
```

### Running alongside OpenWorker

**Prerequisites:** Node 22.13 or newer — polyflow uses `node:sqlite`, which
needs `--experimental-sqlite` on earlier 22.x — and OpenWorker installed. The
`engines` field enforces the floor at install time. polyflow needs no API key of
its own: it never calls a model.

**1. Register it.** From the polyflow directory:

```bash
node bin/polyflow-install.mjs --agent openworker/cowork --workspace acme
# --print shows the entry and the target path without writing anything
```

This merges a `polyflow` entry into OpenWorker's global `mcpServers` file — the
same one the Connectors page edits (`%APPDATA%\coworker\mcp.json` on Windows,
`~/.config/coworker/mcp.json` otherwise, `$COWORKER_STATE_DIR` overriding both).
It merges rather than replaces, and refuses to touch a file it cannot parse.

**2. Restart OpenWorker.** There is no polyflow daemon to start or supervise:
OpenWorker spawns `bin/polyflow-mcp.mjs` over stdio when a session opens and
tears it down with the session. Run state lives in the SQLite file at
`POLYFLOW_DB`, so it survives both.

**3. Check it came up.** The six tools appear as `mcp__polyflow__*`. Ask the
agent to *"list the workflows you can run"* — it should come back with
`customer-brief`, its `admitted: true`, and the five guarantees it was admitted
under. If it does not, the Connectors page carries the standing error, and the
server's own startup lines (`admitted:` / `REFUSED:`) go to stderr.

**4. Use it.** Nothing special: give the agent a task a workflow covers and it
picks the workflow up on its own — that is what
[`FINDINGS-phase3.md`](FINDINGS-phase3.md) measures. To put a recurring job on
it, create an ordinary OpenWorker automation whose instructions describe the
task; the workflow re-attaches by derived key on every fire instead of starting
over.

**Areas.** `--agent` is the agent-class area (which library of workflows this
kind of agent draws on) and `--workspace` is the instance area (whose runs
these are).

One install can serve several workspaces, but each needs its own entry under
its own key — a second run of the installer with the same `--name` replaces the
first:

```bash
node bin/polyflow-install.mjs --workspace acme
node bin/polyflow-install.mjs --name polyflow-beta --workspace beta --db ~/.polyflow/beta.sqlite
```

Point both at the same `--db` to share a store, or at different files to keep
the runs apart.

**Where state lives.** Run from a clone, the store is `.polyflow/polyflow.sqlite`
and the library is `./workflows`. Installed as a package, both default to
`~/.polyflow/` instead — a global install lives under `node_modules`, which the
next upgrade deletes and re-extracts, and durable runs must not be in there.
`--db` and `--workflows` override either.

**Adding your own workflow.** Copy `workflows/customer-brief/` into your library
directory (`POLYFLOW_WORKFLOWS`, printed by the installer) and edit the six
files (see [A workflow](#a-workflow) below). Restart the server: a workflow
that fails its emission check is refused at startup and cannot be started at
all, so a bad edit fails loudly rather than at 3AM.

**Permissions.** The installed entry sets `requires_approval: false`
deliberately — polyflow tools reach nothing outside the machine, and the run's
real side effects are the agent's OWN tools, which keep their own gates.
Prompting on every `workflow_report` would put a dialog between the agent and
its own bookkeeping. The entry also declares `tool_risk` for the read-only
tools, honoured with `upstream/0001-mcp-per-tool-risk-level.patch` applied and
harmlessly ignored without it.

**Where polyrun comes from.** polyflow embeds
[polyrun](https://github.com/cognitive-fab/polygraph) in process, resolved from
`node_modules/polygraph`, then a sibling checkout. Setting `POLYFLOW_POLYRUN`
overrides both, and a value that does not contain a polyrun build is an error
rather than a silent fall-back to the packaged one.

### Other agent hosts

polyflow is a plain MCP stdio server, so anything that speaks MCP can use it.
The installer writes the right file for each host:

```bash
node bin/polyflow-install.mjs --host kiro          # ~/.kiro/settings/mcp.json
node bin/polyflow-install.mjs --host kiro --scope workspace   # ./.kiro/settings/mcp.json
node bin/polyflow-install.mjs --host claude-code   # ./.mcp.json
node bin/polyflow-install.mjs --host generic       # prints the entry, writes nothing
```

Two hosts take a different shape and are printed rather than written:

```bash
node bin/polyflow-install.mjs --host nemo      # YAML for a NeMo Agent Toolkit workflow
node bin/polyflow-install.mjs --host registry  # AWS CLI call to publish an Agent Registry record
```

- **Kiro / Kiro Crew** reads `mcpServers` from `~/.kiro/settings/mcp.json` (user)
  or `.kiro/settings/mcp.json` (workspace, which wins on a name clash). Kiro
  Crew's recurring unattended jobs are the same shape as OpenWorker's scheduled
  jobs, which is the case the results in
  [`FINDINGS-phase3.md`](FINDINGS-phase3.md) are about.
- **NVIDIA NeMo Agent Toolkit** connects through its `mcp_client` function
  group (needs `nvidia-nat-mcp`). The printed block declares the group and adds
  it to a workflow's `tool_names`. NeMo can also run as an MCP server itself, so
  a NeMo workflow can be one of the tools a polyflow work order names.
- **AWS Agent Registry** is a catalog rather than a runtime: publishing a record
  lets other people and agents in the organization discover polyflow. Records
  can be synchronized from an HTTPS endpoint, which a stdio server has no way to
  offer, so the printed command creates a manual MCP record instead.

The registry and polyflow both gate on approval, but not the same approval. A
curator approves that a server may be **found**; polyflow's admission check
decides that a workflow may **run**. Those are different questions, and an
organization can use both: publish polyflow in the registry so teams can
discover it, and let polyflow refuse the workflows that break their own rules.

**Only the OpenWorker path has been exercised end to end** (see
[`FINDINGS-phase2.md`](FINDINGS-phase2.md)). The others are built from each
host's documented configuration format and have not been run.

Env vars, whichever host you use:

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
| `workflow_start` | start **or re-attach** — the run's identity is derived from validated input, so a nightly task resumes instead of restarting and an agent cannot rename its way to a second run |
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
polyflow.workflow.json   name, area, tools{effect kind -> agent tool},
                         key{template,fields} — the run's identity, derived
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
✔ the run key is derived from input, not chosen by the caller
✔ an invalid key field is refused with an instruction, not honoured
✔ a finished run says so, and says not to start another
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
