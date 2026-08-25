# Phase 2 — the seam, proven against OpenWorker's own code

`test/integration/openworker_seam.py` imports `coworker.mcp.client`,
`coworker.mcp.tools` and `coworker.tools.registry` from the spike checkout and
drives polyflow exactly the way `coworker/server/manager.py:1304` does. Not a
mock of the seam — their client, their registry, their schema bridge.

```
npm run test:seam        # 14 checks, 0 failed
```

## Headline: no core change is required

The integration works against unmodified `andrewyng/openworker@7fc3ee6`.

| check | result |
|---|---|
| `MCPManager.ensure` connects to `bin/polyflow-mcp.mjs` over stdio | 6 tools discovered |
| all six tools register in `ToolRegistry` | `mcp__polyflow__workflow_*` |
| `workflow_start` keeps `required: [workflow, key]` through the aisuite schema bridge | intact |
| tool names fit OpenAI's 64-char limit | longest is `mcp__polyflow__workflow_journal` |
| the PermissionEngine gates polyflow tools | `requires_approval=True`, no core change |
| `workflow_list` arrives with its guarantees intact | all five invariant names |
| a full run drives through their registry | gather → draft → approve → **denied**, no post ordered |
| the journal survives the round trip | 5 steps incl. the `DENIED` |

The last row is the one that matters: **the denial ended the run and no
`post_brief` order was ever created**, driven entirely through OpenWorker's
tool-calling path. That is the demo, minus the model.

Two behaviours worth recording:

- **A tool error is a result, not an exception.** An MCP `isError` response
  surfaces to the registry as `{"error": "unknown instance '…'"}` — their
  client normalizes it. polyflow's error strings are therefore model-readable
  as-is; no exception ever crosses into the turn engine.
- **The dependency floor is small.** The MCP stack imports cleanly with only
  `mcp`, `aisuite` and `docstring_parser` — none of `openai`, `anthropic`,
  `textual` or `fastapi`. Integration testing does not need the whole app.

## The one patch worth sending

`upstream/0001-mcp-per-tool-risk-level.patch` — **15 lines across 2 files.**

`coworker/mcp/tools.py` hardcodes `risk_level="medium"` for every MCP tool.
Two consequences for any MCP server, not just polyflow:

- `engine._parallel_safe` requires `"low"`, so a server's **read-only tools can
  never run in parallel** with anything.
- Reads and writes are indistinguishable to the permission engine, so the only
  dial is the server-wide `requires_approval` — all-or-nothing. For polyflow
  that means either every `workflow_state` poll prompts the user, or
  `workflow_report` (which advances a run) is ungated. Neither is right.

The patch adds an optional `tool_risk: {"tool": "low"|"medium"|"high"}` to the
standard `mcpServers` JSON and honours it, defaulting to `"medium"` and
**ignoring any unrecognised value — fail closed**. Verified through the seam:

```
PASS  patch: declared read-only tools grade as low risk
PASS  patch: undeclared tools stay medium (fail closed)
PASS  patch: an unrecognised risk value is ignored, not trusted
```

This is the shape that empirically merges in that repo: small, obviously
correct, useful to every MCP server rather than to ours. It is a
quality-of-life fix, **not a blocker** — say so in the PR.

## Not needed after all

Phase 1 listed two other candidate PRs. The integration retired both:

- **`workflow_ref` on `ScheduledTask`** — unnecessary. A stable
  `workflow_start` key derived from the task is enough to re-attach, and it
  needs no schema change.
- **Routing a parked order to the Inbox** — unnecessary. polyflow orders
  `ask_user` as an ordinary work order; OpenWorker's existing `ask` → Inbox →
  `resolve_inbox` → `_durable_resume` path handles the wait, and polyflow's own
  timer bounds it. The two durability models compose rather than compete:
  theirs resumes the *conversation*, ours holds the *process*.

## What is still untested

- **No model in the loop.** Every tool call here was made by the test, not
  chosen by an LLM. Whether a model reliably picks `workflow_report` over
  free-styling the next tool is the open question, and it needs an API key and
  a real session to answer.
- **No GUI / scheduler run.** The automation scheduler firing a task that
  attaches to a polyflow run has not been exercised end to end.
- **Their test suite was not run** against the patch (needs the full dependency
  set). The patch is verified through the seam only.

## Next

1. Real session with a model: does the agent stay on the rails?
2. Then file the patch, with the demo in the issue thread rather than in the PR.
