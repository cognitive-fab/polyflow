# Phase 0 — OpenWorker spike findings

Spike clone: `spike/openworker` (andrewyng/openworker @ 7fc3ee6, MIT).
Purpose: answer the four seam questions before building polyflow. **Not** a PR branch.

---

## Q1. Does the approval-park survive a restart?

**Yes — and this corrects the earlier assumption.** OpenWorker already has durable
resume of a suspended turn.

- `coworker/engine.py:396` `async def resume()` — *"Continue a turn that was suspended
  at a prompt and persisted — durable resume after a restart (or engine eviction)."*
  It re-processes the trailing assistant message's **unanswered tool-calls**
  (`_unanswered_trailing_tool_calls`, engine.py:413), whose prompt callbacks find the
  already-resolved Inbox item and return without re-prompting. Answered calls are
  skipped, so nothing double-executes.
- `coworker/server/manager.py:1164` `resolve_inbox()` → if `not is_running(session)`,
  `_durable_resume(item)`: rebuild the engine from the saved thread, run `resume()`, save.
- Inbox items carry `tool_call_id` *"for durable resume (idempotent inbox item)"*
  (engine.py:67). `persist_session()` saves the thread so a pending tool call survives a crash.

**Consequence: the "3AM automation parks until you approve at 9AM" demo already works.**
Do not pitch it as new. It was going to be our headline.

Two real limits remain:
- `Scheduler.stop()` (automation/scheduler.py) **cancels in-flight spawned runs** on
  shutdown — *"a suspended run must not outlive us."* Recovery is triggered by
  **resolution of the Inbox item**, not by startup. If nobody answers, nothing resumes.
- There is no deadline, timeout, or escalation on a parked approval. A run can sit
  forever with no record that it is overdue.

## Q2. What is the durable unit?

**The conversation transcript.** State is the message list; resume means rebuilding an
LLM engine from it and re-running the loop. There is no task state outside the messages.

- `compaction.py` header: *"The persisted transcript is never modified; only what is
  sent to the model."* So resume reads a faithful thread — no bug here — but the
  **model's view** after resume is the compacted one: older turns replaced by an
  LLM-written summary, tool results clipped to 400 chars first
  (`_SPAN_TOOL_RESULT_CLIP`). Long-running work resumes into a lossy summary of itself.
- Every resume re-sends the thread. Cost scales with history, not with remaining work.
- `max_iterations` bounds a turn; nothing bounds a process.

## Q3. What constrains a resumed run? — **the actual gap**

**Nothing.** Approval is granted per tool-call. Once `resume()` hands control back to
`_loop()`, the model is free: no statement of what the run may still do, no invariant
over the remaining path, no terminal condition other than the model deciding it's done.

The permission engine is the only constraint, and it works on **verbs, not plans**:
`always_allowed_tools` entries are `"tool target"` strings (automation/models.py,
`rule_entry`/`grant_entries`), fail-closed, write-only, target-bound. That is the best
achievable when the plan is a prose `instructions` string. Open PR #301
(*"exclude exec-risk tools from session_allow_tools shortcut"*) is evidence the
verb-level model has known holes.

**Revised polyflow wedge: not durability — constraint.**
> OpenWorker can already resume a parked run. It cannot tell you what the resumed run
> is allowed to do.

## Q4. Is the MCP seam strong enough?

**Yes, stronger than expected.** `coworker/mcp/tools.py` wraps each MCP tool as a sync
callable with:
- an explicit OpenAI schema built from the MCP `inputSchema` (`__coworker_schema__`),
- `ToolMetadata(category="mcp", risk_level="medium", requires_approval=server.requires_approval)`,
  so **the PermissionEngine gates polyflow tools for free**,
- per-server `include_tools` / `exclude_tools` filtering.

`tools/registry.py` honors `__coworker_schema__` overrides, so schema fidelity is ours
to control. Nothing in the core needs to change for polyflow to be callable.

Caveat: `risk_level` is hardcoded `"medium"` for all MCP tools, and `_parallel_safe`
(engine.py:849) requires `"low"` — so polyflow's read-only tools (`workflow_state`,
`workflow_list`) can never run in parallel with others. Minor perf ceiling; also the
shape of a small, obviously-correct upstream PR later.

---

## Carried forward (unchanged by the spike)

- **Every cron fire re-plans from prose.** `ScheduledTask.instructions: str`;
  automation/models.py docstring: *"Each fire is a fresh Run of the task's instructions."*
  No state, no learning, no reuse across fires. This gap is real and is now the
  efficiency half of the pitch.
- **No procedural memory.** `memory/base.py` is `{content, summary, key}` over
  global/workspace/session scopes, injected as prose, flipping to an index past
  `INDEX_THRESHOLD_CHARS = 8_000` (~50–100 memories). Procedures cannot live there.
- **`selfwake.py` is an ally, not a competitor.** Timer / completion / **event** wakes
  (`wake_on_event(event_key)`) with a JSON-backed `WakeStore`, consumed by the scheduler
  tick. polyflow should *drive* it: a polyrun effect completion fires the event key that
  wakes the session. Do not reimplement suspension.
- **Areas map to fields that already exist**: agent-class ← `ScheduledTask.agent`
  (+ `personas/`, `teams/`); instance ← `workspace` (== `Scope.WORKSPACE`).

## Decisions

1. **Drop the durability headline.** Lead with constraint + reuse.
2. **Build over MCP.** No fork needed for v0 distribution; the IP boundary falls on the
   MCP line, which keeps polyrun/polygraph out of an MIT repo by construction.
3. **Integrate with `selfwake`, not around it.** `wake_on_event` is the resume bridge.
4. **Candidate goodwill PRs** (small, obviously-correct — the shape that merges there):
   MCP `risk_level` overridable; a deadline/escalation on parked approvals.
