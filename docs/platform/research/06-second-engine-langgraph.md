# 06 — Plan P10: a second engine binding, LangGraph (G0/G1)

**Question.** Is the governance kernel really engine-neutral? Can a second
engine get the same ledger and the same guard at G0/G1 without a kernel change,
so that Temporal is the thesis, not a single point of failure (external
feedback 1, §1)?

**Answer: yes, at G0/G1.** `platform/python/polyflow_langgraph/` governs the tool
calls of an unmodified prebuilt LangGraph ReAct agent. It uses the Python kernel
unchanged (canonical JSON, ledger, rule kernel, redaction, sinks, head signing)
and imports no `temporalio`. Each tool call becomes proposal → verdict → effect →
observation in the same hash-chained format. The TypeScript `polyflow verify`
accepts the ledger as "consistent, closed and signed". The conformance guard
vectors (`guard.json`, `routed-guard.json`) give byte-identical decisions,
witnesses and states through the binding's guard path.

Built on 2026-09-22 against langgraph 1.2.12, langgraph-prebuilt 1.1.0 and
langchain-core 1.6.4, with Python 3.12.10.

---

## 1. What was built

| File | What it is |
|---|---|
| `platform/python/polyflow_langgraph/binding.py` | `govern(tools, level, policy, sink, signing_key, ...)` returns a `ToolNode` that has the governor on `.governor`. The file also has `Governor`, with `wrap_tool_call`/`awrap_tool_call`, `close`, and `snapshot`. It has the pure guard path `govern_effect`/`observe_effect`, `ledger_of(state)` (which rebuilds the record from a thread's state), and `checkpoint_ms`. |
| `platform/python/polyflow_temporal/sinks.py` | `FileSink`, `MemorySink`, `partition_delta`, `safe_component`, `sign_head`/`head_message`, moved out of `plugin.py` without a change so that they import without Temporal. `plugin.py` re-exports them under the old names. |
| `platform/python/tests/test_langgraph.py` | 16 tests, offline, using a scripted chat model (§4). |
| `platform/python/pyproject.toml` | Adds the extra `langgraph = ["langgraph>=1.0,<2"]` and an explicit package list. |

Usage. The agent's code is unchanged, and only the tool list is wrapped:

```python
from polyflow_langgraph import govern
from polyflow_temporal.sinks import FileSink

tools = govern([read_ticket, issue_refund], level="guard", policy=admitted, sink=FileSink("./ledger"), signing_key=key)
agent = create_react_agent(model, tools, checkpointer=saver)
agent.invoke({"messages": [...]}, {"configurable": {"thread_id": "t-42"}})
tools.governor.close(agent, {"configurable": {"thread_id": "t-42"}})   # optional: the final closure
```

## 2. The seam and why it was chosen

The binding uses **`ToolNode(wrap_tool_call=..., awrap_tool_call=...)`**, the
interceptor that langgraph-prebuilt 1.x provides at tool execution. It receives
the model's tool call, the agent's state and the runtime (thread, checkpoint id,
task). It may run the tool or not, and it returns the `ToolMessage` that the
model reads. `create_react_agent(model, tools)` accepts a `ToolNode` in place of
a tool list and uses it as it is, so the graph does not change.
`langchain.agents.create_agent` middleware has the same `wrap_tool_call(request,
handler)` shape, so `Governor.wrap_tool_call` fits there too (not tested, because
`langchain` is not installed).

Two other seams were rejected:

- A callback handler can observe but cannot refuse.
- Wrapping each `BaseTool` loses the agent state and the checkpoint id, and
  durability depends on both.

## 3. Durability: what LangGraph guarantees, and what the binding builds on it

**LangGraph is not Temporal.** Its code is not replayed deterministically, and
it has no event history. A tool runs **at least once**. A node that raises, or a
process that dies, re-runs from the last checkpoint. The binding relies only on
what LangGraph does persist:

1. The model's tool calls are in a checkpoint before any tool runs. A resumed
   step re-runs from that same checkpoint, and its id is exposed as
   `runtime.execution_info.checkpoint_id`. The id is a uuid6 and carries its
   own timestamp.
2. With `create_react_agent`'s default `version="v2"`, each tool call is its own
   task (`Send`). A finished task's write (its `ToolMessage`) is saved as a
   pending write and is not run again.

The binding builds three properties on these facts.

**A model turn is decided as one batch, from the checkpoint.** The decisions for
one AIMessage's tool calls depend only on checkpointed data:

- the chain head and guard state carried in the thread;
- the tool calls, in order;
- the checkpoint's own time, used as the decision time. A Temporal workflow task
  also has one time.

Every parallel task of the step, and every re-run of it (in the same process or
another one), therefore derives the **same** events. The events are written to
the sink **before** the tool runs, and the sink skips events it already holds.

**The chain is carried in the checkpoint.** Each `ToolMessage` carries the batch
(its events, head and guard state) and the call's outcome (ok, result digest or
redacted error, finish time). They go in `response_metadata["polyflow"]`, which
is never sent to a model. The next batch, or `close`, turns those outcomes into
observations in call order, stamped with the times the tools finished. So:

- A resumed thread continues **one** chain, in a fresh process with a fresh
  `Governor` (tested). An interrupt before the tools, a node that failed, and a
  parallel step where one task died all continue the same chain.
- A re-run records nothing twice and spends no budget twice. The re-run is the
  **same** effect, with the same idempotency key `"<thread>/<tool_call_id>"`, and
  the guard committed it once (tested: a refund whose worker died mid-call is
  re-run and recorded once, and a second refund is still denied).
- `ledger_of(state)` rebuilds the record from the checkpoint alone. It plays the
  part that `polyflow export` plays for a Temporal history. The exporter uses
  it to back-fill a sink that fell behind.

**Divergence is recorded, not hidden.** Two cases diverge from what the sink
holds:

- a thread that goes on after `close`;
- a time-travel fork from an older checkpoint (`update_state`, or
  `checkpoint_id` in the config).

The sink refuses the delta whole. The binding then starts a new chain, whose
admission body contains `continues: {run, seq, hash}`. That chain carries the
thread's guard state forward, so a spent budget stays spent (tested). The
branch is reported through `on_conflict`.

### What is not guaranteed

- **At-most-once tool execution.** LangGraph re-runs a tool whose task did not
  finish. The ledger records one effect with one idempotency key, but the side
  effect may have happened twice. Tools with external effects should
  de-duplicate on the idempotency key. This is the same contract as a Temporal
  activity.
- **An outcome that is never persisted.** If a tool ran but its task never
  wrote (the process died and the thread was never resumed), the sink holds
  proposal, verdict and effect with no observation. That is honest ("started,
  outcome unknown"), but the record is open. A missing `ToolMessage` found at
  the next batch (for example, removed by message trimming) is recorded as
  `ok: false, "no outcome recorded"`.
- **Replay determinism of the agent.** Nothing checks that the graph code is
  deterministic. Temporal's replayer does check this. The binding's determinism
  covers its own events only.
- **Closure.** A LangGraph thread has no end. `close()` appends the closure and
  is idempotent for the same final checkpoint. Without it, verify the ledger
  with `--allow-open`.
- **Checkpoint ids.** The decision time comes from a uuid6 checkpoint id, and
  every LangGraph saver gets its ids from the Pregel loop. Given any other id,
  the binding falls back to wall time, and a re-run would then conflict rather
  than dedupe.
- **Tools that return a `Command`.** The outcome is carried only when the
  Command's `messages` update contains that call's `ToolMessage`.
- **The async path** (`ainvoke`) writes the sink synchronously.

## 4. Tests (`tests/test_langgraph.py`, all offline)

| Claim | Test |
|---|---|
| (a) every tool call is recorded, and the guard decides | `test_every_tool_call_is_recorded_and_the_guard_decides`: refund before read is denied (`read-before-refund`), read and refund are allowed, a second refund is denied (`one-refund`), and only the allowed calls ran. Also `test_observe_records_without_a_policy` (G0) and `test_the_async_path_records_and_decides_the_same`. |
| (b) the model sees the witness | The denied call's `ToolMessage` (status `error`) is `{"error": "PolyflowDenied", message, rules, witness}`, and its witness digest equals the one in the ledger's verdict |
| routes | `test_a_routed_generic_tool_is_classified_by_the_tool_it_carries`: `call_tool(tool_name=...)` with `routes: {"call_tool": "0.tool_name"}`. A parallel turn gets one refund, and a case variant is denied as routed and undeclared (SEC-UL1) |
| (c) resume continues one chain | `test_a_thread_resumed_in_a_fresh_process_continues_one_chain` (an interrupt before the tools, then a new Governor), `test_a_step_that_dies_mid_tool_is_re_run_but_recorded_once_and_charged_once` (a parallel step with one task dying, then a refund dying), `test_a_closed_thread_that_goes_on_starts_a_linked_chain` |
| (d) `polyflow verify` accepts it | `test_a_langgraph_ledger_verifies_under_the_typescript_cli`: signed with a `polyflow keygen` key, written by two processes' `FileSink`s across a resume, and reported as "consistent, closed and signed" |
| (e) conformance | `guard.json` and `routed-guard.json` replayed through `govern_effect`/`observe_effect`: the same decisions, witness digests, classifications and state digests |
| neutrality | `test_the_binding_does_not_import_temporalio` runs in a clean interpreter |

## 5. How it differs from the Temporal plugin

| | Temporal plugin | LangGraph binding |
|---|---|---|
| Unit of governance | an activity, child, signal or Nexus call | a tool call (`via: "langgraph-tool"`) |
| Where the record is durable | the workflow history (ledger headers) | the checkpoint (`ToolMessage.response_metadata`) |
| Export | the activity interceptor, after history | write-ahead of the tool, deterministic, so re-runs are skipped |
| Decision time | workflow time | the checkpoint's uuid6 time |
| Chain identity | `{ns, workflowId, first runId}` | `{ns: "langgraph", wf: thread_id, run: first governed checkpoint id}` |
| Hand-over | Continue-as-New carries the head and guard state | the checkpoint carries them. A divergence starts a linked chain |
| Proposal `source` | `workflow` | `model` |
| Escalation | refused (no inbox in Python) | refused. LangGraph `interrupt()` would be the natural inbox, but it is not built |
| G2/G3, sealed headers, verified principals | yes | no (out of scope for P10) |

**Packaging note.** The binding ships in the same `polyflow-temporal`
distribution, so a LangGraph-only install still pulls `temporalio`, although it
never imports it. Splitting the kernel into its own distribution is a packaging
follow-up. The `langgraph` extra pulls certifi (MPL-2.0) through httpx. That
extra is the only place it enters, as for `openai-agents` (licence audit L7).
