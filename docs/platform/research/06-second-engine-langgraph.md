# 06 — Plan P10: a second engine binding, LangGraph (G0/G1)

**Question.** Is the governance kernel really engine-neutral? Can a second
engine get the same ledger and the same guard at G0/G1 without a kernel change,
so that Temporal is the thesis, not a single point of failure (external
feedback 1, §1)?

**Answer: yes, at G0/G1.** `platform/python/polyflow_langgraph/` governs the tool
calls of an unmodified prebuilt LangGraph ReAct agent. It uses the Python kernel
unchanged (canonical JSON, ledger, rule kernel, redaction, sinks, head signing)
and imports no `temporalio`. A thread's chain and guard state are kept in a
per-thread record beside the sink, and never in the agent's messages. Each tool call becomes proposal → verdict → effect →
observation in the same hash-chained format. The TypeScript `polyflow verify`
accepts the ledger as "consistent, closed and signed". The conformance guard
vectors (`guard.json`, `routed-guard.json`) give byte-identical decisions,
witnesses and states through the binding's guard path.

Built on 2026-09-22 against langgraph 1.2.12, langgraph-prebuilt 1.1.0 and
langchain-core 1.6.4, with Python 3.12.10.

---

## 1. What was built

The design changed after the P10 review ([`reviews/P10-review.md`](../reviews/P10-review.md)).
The first version carried the chain and the guard state in the agent's
messages, and that let anyone who could edit the list reset or forge them.
This section and §3 describe the design as it now stands.

| File | What it is |
|---|---|
| `platform/python/polyflow_langgraph/binding.py` | `govern(tools, level, policy, sink, store, signing_key, ...)` returns a `ToolNode` that has the governor on `.governor`. The file also holds: `Governor`, with `wrap_tool_call`/`awrap_tool_call`, `close` and `snapshot(thread)`; the pure guard path `govern_effect`/`observe_effect`; `idempotency_key`; `verify_thread` (the thread-level check, VF1); and `checkpoint_ms`. |
| `platform/python/polyflow_langgraph/store.py` | The per-thread governance record: `MemoryThreadStore` and `FileThreadStore` (`<root>/<ns>/<thread>/thread.state.json` beside the `FileSink`'s run files, written atomically under an OS file lock; retained tool results are blobs under `results/`, one per effect, so the record stays small). `store_for(sink)` places it with the sink by default. |
| `platform/python/polyflow_temporal/sinks.py` | `FileSink`, `MemorySink`, `partition_delta`, `safe_component` and `sign_head`/`head_message`, moved out of `plugin.py` so that they import without Temporal. `FileSink` now re-reads a run file that another writer changed (LG7). |
| `platform/python/tests/test_langgraph.py`, `tests/test_review_p10.py` | 19 and 12 tests, offline, with a scripted chat model (§4) |
| `platform/python/pyproject.toml` | `langgraph = ["langgraph>=1.2,<2", "langgraph-prebuilt>=1.1,<2"]` (the versions tested) and an explicit package list |

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
- Wrapping each `BaseTool` loses the thread and the model turn, and the guard
  needs both.

`govern` builds the `ToolNode` itself, from the tools, so that it knows which
tool names are real. Any other name the model uses is recorded as `<unknown
tool>` plus a digest. At guard level it is refused (LG9).

## 3. Durability: what LangGraph guarantees, and what the binding builds on it

**LangGraph is not Temporal.** It does not replay code deterministically, and it
keeps no event history. A tool runs **at least once**: a node that raises, or a
process that dies, re-runs from the last checkpoint. A replay from an old
`checkpoint_id` runs a completed step again. Anything that can call
`update_state`, send API input or trim the history can rewrite the message list.

**Where the authority lives.** A thread's chain head, guard state, decided turns
and effect outcomes are kept in a **per-thread record**, keyed by `(ns,
thread_id)`. The record sits beside the sink: `thread.state.json` next to a
`FileSink`'s files, or in memory next to a `MemorySink`. Any other sink needs an
explicit `store=` at guard level, and it must implement the sink protocol
(`write`, `head`, `runs_of(ns, wf)`): `runs_of` is how the guard tells that a
thread's ledger already exists (the fail-closed check) and how `verify_thread`
reads a thread. A guard-level sink without it is refused at construction.

Retained tool results (for replays) are kept as blobs beside the record, one per
effect, never inside it: a transaction reads and writes the small record only.
A result JSON cannot carry is written as its `str`; writing the outcome never
fails after the tool ran.

The binding never reads anything back from message metadata. The
`response_metadata["polyflow"]` it attaches (effect id and idempotency key) is
there for people to read. Every decision is a read-modify-write of the record
inside a transaction, which holds a lock both in-process and at OS file level.
So parallel Send tasks, subagents that share a thread, and several workers over
one ledger directory all serialise on the thread (LG5, LG7).

**A model turn is decided once.** A turn is identified by its AIMessage's id and
its calls (id, tool name, argument digest). It is decided against the thread's
current guard state, and its events are appended to the thread's one chain and
exported. Any later sight of the same turn gets the stored decisions: a sibling
task, a crash re-run, or a replay from an old checkpoint.

**Each decision is bound to its call.** A call executes only under the entry
whose (id, name digest, argument digest) equals the call being executed (LG1,
FO1). A turn whose ids repeat, or that has a call with no id, is refused whole.
The witness says why, so the model can retry.

**Effects are observed when they return.** The observation is appended as soon
as the tool returns, stamped with that moment. The effect is stamped with the
decision time. The checkpoint id the call ran under is recorded in the proposal
(TM1).

| Case | What happens |
|---|---|
| Crash re-run (the tool raised, or the process died before its outcome was recorded) | The same effect runs again. Its observation says `attempts: 2`. The re-execution is recorded, not hidden. |
| Replay of a step whose effect was already observed (LG8) | The tool does **not** run again. The recorded result is returned (for the last 256 effects of a thread; older ones get a `PolyflowReplay` refusal). |
| Trimmed history (LG3), time-travel fork (LG4) or custom `messages_key` (LG6) | The next turn is decided against the thread's latest state, so a spent budget stays spent. A fork is also reported through `on_conflict`. |

**Linked chains.** A thread has one chain until `close()`. A thread that goes on
after a close gets a new chain whose admission `continues` the closure, and the
guard state carries over. `verify_thread(sink, thread)` checks the thread as one
record (VF1):

- every chain verifies;
- exactly one chain is the root;
- every link resolves to a closure, and no closure is continued twice;
- at most one chain is open;
- every effect follows an `allowed` verdict;
- every observation names a known effect, once.

**Fail closed.** At guard level, the governor refuses a call rather than guess:

- a call with no thread or no checkpoint (a graph without a checkpointer, or a
  langgraph without `execution_info`), unless `allow_unthreaded=True` (LG11);
- a call whose model turn is not in the state under `messages_key`;
- a call on a thread whose ledger exists but whose record is missing.

The binding never back-fills or signs an event that its own record did not
append, so no planted message can get a chain signed (LG2).

### What is not guaranteed

- **At-most-once tool execution.** A tool whose outcome was not recorded
  (crash) runs again. The ledger records one effect and the number of attempts,
  and tools with external effects should de-duplicate on the idempotency key.
  The key is a digest of the chain and the effect id, so it is unique per
  effect (LG10). This is the same contract as a Temporal activity.
- **The record is as durable, and as shared, as its store.**
  - `MemoryThreadStore` lives in one process.
  - `FileThreadStore` needs every worker on the same filesystem, with working
    OS locks (a local disk, or a network filesystem whose locking you trust).
  - Several hosts without a shared filesystem need a store behind the
    governance service. That store is not built.
  - The record is operator-side state, like the sink. The agent and API input
    cannot reach it. Anyone with write access to the store can rewrite it, as
    they could the sink.
- **An outcome that is never recorded.** If a tool ran and the process died, and
  the thread is never resumed, the record holds an open effect. `close()`
  observes it as `ok: false, "no outcome recorded before close"` and folds
  that outcome into the guard state (taint, trace) like any failed outcome, so
  the next linked chain inherits it.
- **Fork detection is a heuristic.** Each decided turn records its parent (the
  latest decided turn present in its state). A turn is reported as a fork when
  its state holds a decided turn from which a later, absent turn descends. A
  subagent with its own message list has its own lineage, so its newer turns
  are not reported as forks of the main agent's (tested). The report is only a
  warning: governance always uses the thread's latest state.
- **Old turns.** The record keeps the last 512 turns. A replay of an older turn
  is decided again, against the current state, so budgets still hold.
- **Replay determinism of the agent.** Nothing checks that the graph code is
  deterministic. Temporal's replayer does check this.
- **Closure.** A thread has no end. `close()` appends the closure and is
  idempotent. Without it, verify with `--allow-open`.
- **Tools that return a `Command`.** The observation carries the result digest
  only when the Command's `messages` contain that call's `ToolMessage`.
  Otherwise the call is observed as `ok` without a result.
- **`polyflow verify` (TypeScript) checks one chain file.** The thread-level
  check is Python's `verify_thread`. A `polyflow verify --thread <dir>` with the
  same rules is proposed for the TypeScript CLI.

## 4. Tests (all offline)

| Claim | Test |
|---|---|
| (a) every tool call is recorded, and the guard decides | `test_every_tool_call_is_recorded_and_the_guard_decides`, `test_observe_records_without_a_policy` (G0), `test_the_async_path_records_and_decides_the_same` |
| (b) the model sees the witness | The denied call's `ToolMessage` is `{"error": "PolyflowDenied", message, rules, witness}`, and its witness digest equals the one in the ledger |
| routes | `test_a_routed_generic_tool_is_classified_by_the_tool_it_carries` |
| (c) resume continues one chain | `test_a_thread_resumed_in_a_fresh_process_continues_one_chain`, `test_a_step_that_dies_mid_tool_is_re_run_but_recorded_once_and_charged_once` (attempts recorded), `test_a_closed_thread_that_goes_on_starts_a_linked_chain` |
| (d) `polyflow verify` accepts it | `test_a_langgraph_ledger_verifies_under_the_typescript_cli`; LG7 (two long-lived workers over one directory) |
| (e) conformance | `guard.json` and `routed-guard.json` through `govern_effect`/`observe_effect` |
| review findings | `test_review_p10.py`: LG1a/b (bound decisions, repeated ids refused), LG2 (a planted chain is never signed), LG3 (trimming), LG4 (time travel), LG5 (parallel subagents), LG6 (`messages_key`), LG7 (two workers), LG8 (replay), LG9 (names), LG10 (keys), LG11 (no `execution_info`) |
| fail closed, VF1 | `test_a_thread_whose_record_is_missing_while_its_ledger_exists_is_refused`, `test_no_checkpointer_is_refused_unless_explicitly_allowed`, `test_verify_thread_reports_unlinked_chains_and_effects_without_an_allowed_verdict` |
| neutrality | `test_the_binding_does_not_import_temporalio` |

## 5. How it differs from the Temporal plugin

| | Temporal plugin | LangGraph binding |
|---|---|---|
| Unit of governance | an activity, child, signal or Nexus call | a tool call (`via: "langgraph-tool"`) |
| Where the chain and guard state live | the workflow history (ledger headers, sealed with a key) | the per-thread record beside the sink (never the agent's messages) |
| Export | the activity interceptor, after history | from the record, under the thread's lock, before the tool runs |
| Decision time | workflow time | the wall time of the decision (the checkpoint id is in the proposal) |
| Chain identity | `{ns, workflowId, first runId}` | `{ns: "langgraph", wf: thread_id, run: first governed checkpoint id}` |
| Hand-over | Continue-as-New carries the head and guard state | the record does. After `close`, a linked chain continues it |
| Re-execution | an activity retry is the same effect | a crash re-run is the same effect (with `attempts`). A replay of an observed effect returns the recorded result |
| Proposal `source` | `workflow` | `model` |
| Escalation | refused (no inbox in Python) | refused. LangGraph `interrupt()` would be the natural inbox, but it is not built |
| G2/G3, sealed headers, verified principals | yes | no (out of scope for P10) |

**Packaging note.** The binding ships in the same `polyflow-temporal`
distribution, so a LangGraph-only install still pulls `temporalio`, although it
never imports it. Splitting the kernel into its own distribution is a packaging
follow-up. The `langgraph` extra pulls MPL-2.0 code: certifi (through httpx and
requests) and orjson (through langsmith). That extra is the only place they
enter, as for `openai-agents` (licence audit L7b).
