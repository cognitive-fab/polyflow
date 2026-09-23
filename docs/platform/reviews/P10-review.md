# Review: P10 (the second engine binding, LangGraph at G0/G1)

This is an adversarial review of plan step P10, commit `2fe357b`:

- `platform/python/polyflow_langgraph/binding.py` (the `ToolNode` seam, the batch, the carried chain, `close`, `ledger_of`);
- `platform/python/polyflow_temporal/sinks.py` (moved out of `plugin.py`);
- `platform/python/tests/test_langgraph.py`;
- `docs/platform/research/06-second-engine-langgraph.md` (the claims), the `pyproject.toml` extra and the L7b licence row.

The reference for what the ledger and the guard must mean is the Temporal plugin (`polyflow_temporal/plugin.py`, `packages/temporal`) and the conformance vectors in `platform/conformance/*.json`. The reviewer did not write the code and changed no production code.

The question asked was: does the binding guarantee what the doc and the tests claim? The conformance half holds. `govern_effect` and `observe_effect` do reproduce `guard.json` and `routed-guard.json`, and the sinks move is faithful. The durability half does not hold. The binding has one root weakness, and most findings below are instances of it. **The authority for the guard state and the chain head is the `response_metadata` of `ToolMessage`s in the agent's message list.** That metadata is:

- unauthenticated;
- scoped to a message list, not to a thread;
- rewritten by anything that edits the list: trimming, `update_state`, time travel, parallel subagents, or plain API input;
- trusted over the sink when they disagree.

## How to reproduce

| File | Tests | Needs server |
|---|---|---|
| `platform/python/tests/test_review_p10.py` | LG1a, LG1b, LG2, LG3, LG4, LG5, LG6, LG7, LG8, LG9, LG10, LG11 | no. LG2 and LG7 call `node` (keygen and `polyflow verify`), and the module fixtures call `polyflow policy` |

```
cd platform/python && .venv/Scripts/python.exe -m pytest -q tests/test_review_p10.py
```

**Baseline at review time:** `test_langgraph.py` 16/16, and the whole Python suite 483 passed (before the review file was added).

**All 12 review tests fail** (about 6 s), each for the reason its message gives. Each test also checks its setup (for example, "the guard denies the second refund"), so a failure means the stated defect and not a broken fixture. The tests use their own copies of the tools and a scripted model keyed on turns after the last human message. From `test_langgraph.py` they import only `admit`, `call`, `cfg` and `CLI`.

Three probes were run as throwaway scripts, not committed:

- **What `execution_info` holds** with and without a checkpointer. Without one, `thread_id` is `None`, so the thread is `"default"`. Each Send task has its own `checkpoint_ns`.
- **LG8's ledger after a replay.** The original chain ends open at the replayed effect (seq 7). A second chain `continues` it from seq 4, and its verdict for `c3` is `allowed`, with the same idempotency key `r/c3`.
- **`polyflow verify --allow-open` on LG2's forged file:** `langgraph/victim-thread/run-that-never-happened — 6 events … 1 trusted and anchored … OK (open) — consistent and signed`.

---

## Summary

**2 blockers, 6 majors, 6 minors, 2 nits.**

| # | Severity | Finding | Evidence |
|---|---|---|---|
| LG1 | **blocker** | The verdict is looked up by `tool_call["id"]`, and the call that executes is never compared with the call that was decided. Two calls in one turn with the same id (ids are model output) both run under the **first** one's verdict. A second refund denied by `one-refund` runs. A refund denied by `read-before-refund` runs under a read's `allowed`. The ledger records the denial. | LG1a, LG1b |
| LG2 | **blocker** | SEC-EX1 is re-opened in the new binding. The carried batch is trusted as is: its `run` (any `ns`/`wf`/`run`), its events and its guard state. When the sink is "behind", `_export` back-fills from the carried state and **signs the head**. A message planted in thread A gets the worker's key onto a chain for thread `victim-thread`, run `run-that-never-happened`, and `polyflow verify` says "OK (open) — consistent and signed". | LG2, probe |
| LG3 | major | Trimming the history resets the guard. `pre_model_hook` returns `RemoveMessage(REMOVE_ALL_MESSAGES)` plus the recent messages, which is LangGraph's documented way to persist a trimmed or summarised history. The next batch then finds no carried batch, starts `guard.init()` and a new, **unlinked** chain. A second refund runs on the same thread. | LG3 |
| LG4 | major | A time-travel fork re-spends a spent budget. The doc says the linked chain "carries the thread's guard state forward, so a spent budget stays spent (tested)". It carries the **fork point's** state. Only close-then-continue is tested, and there the two states coincide. | LG4 |
| LG5 | major | The guard state belongs to a message list, not to a thread. Two subagents that run in one superstep, under one governor, one thread and a policy of at most one refund, refund twice and write two chains. | LG5 |
| LG6 | major | `govern(..., messages_key="history")` passes the key to `ToolNode`, but the governor reads `state["messages"]`. Every call is then its own batch with a fresh guard. At-most-1 lets every refund through. | LG6 |
| LG7 | major | Two long-lived workers resume one thread, each with its own `FileSink` over the same directory, which is the deployment the doc's test (d) describes. The first worker's cached head goes stale, and its back-fill **re-appends** the other worker's events: stored seqs are `0,1,2,3,4,5,3,4,5,6,…`. `polyflow verify` rejects the file. | LG7 |
| LG8 | major | Replaying a **completed** step (only `checkpoint_id` in the config, with no state edit) runs the refund again, and the guard **allows** it. The replay runs under a new checkpoint id and so at a new time. Its batch conflicts and is re-decided on a linked chain from the pre-refund guard state. This is not the documented at-least-once crash re-run. | LG8, probe |
| LG9 | minor | A model-chosen tool **name** goes into the ledger verbatim and unbounded (`proposal.action`, `effect.activityType`, the witness target). A token in it is not redacted, although failure text is. | LG9 |
| LG10 | minor | The idempotency key `"<thread>/<tool_call_id>"` is not injective, because `/` is legal in both parts and the id is model output. Two refunds on two threads with different arguments share the key `acct/b/c`. §3 tells tools to de-duplicate on this key. | LG10 |
| LG11 | minor | With no `execution_info`, the governor still runs the tool: thread `"default"`, a random `unpersisted-…` checkpoint, wall-clock time, a fresh chain and guard per call. Two causes: no checkpointer (`thread_id` is `None`), and langgraph versions the declared range admits (langgraph 1.0.10 or 1.1.0 with langgraph-prebuilt 1.0.8 has `wrap_tool_call` but no `execution_info`). | LG11, probe |
| VF1 | minor | `polyflow verify` checks a chain, its signatures and a closure. It does not check what this binding relies on: that a `continues` link resolves, that a thread has one live chain, or that each `effect` follows an `allowed` verdict. LG3, LG5 and LG8 leave several chains per thread that each verify on their own. | code |
| FO1 | minor | `wrap_tool_call` executes a call it cannot find in its batch (`binding.py:435`, "cannot happen via ToolNode"). That is a fail-open branch on a path the comment says is unreachable. | code |
| TM1 | minor | Decision time is the checkpoint's uuid6 time, and observation time is the wall clock of whichever process ran the tool. After a human-in-the-loop pause, the ledger dates the verdict and effect days before they happened. The uuid6 decoding is correct, and no rule loosens (see What held up). | code |
| LC1 | nit | L7b names certifi but not `orjson` (MPL-2.0 AND (Apache-2.0 OR MIT)), which comes in through langsmith. certifi comes in through langchain-core → httpx and langsmith → requests, not only through langgraph's httpx. | `importlib.metadata` walk |
| AS1 | nit | `awrap_tool_call` does blocking sink I/O (and FileSink appends) while holding a `threading.Lock` on the event loop. It is documented, but every parallel tool coroutine in the loop serialises behind it. | code |

---

## Blockers

### LG1: a denied call runs under another call's verdict

`binding.py:384-392` and `:431-447`. `_enter` finds the batch for the turn, then picks the decision with `next(c for c in batch["calls"] if c["id"] == cid)`. `wrap_tool_call` then runs `execute(request)` with **`request.tool_call`**. Nothing checks that the chosen entry's `index`, `tool` or `argsDigest` matches the call being executed.

Tool-call ids are model output. The OpenAI and Anthropic APIs do generate unique ids, but a local model, a proxy, a prompt-injected "replay this tool call" or a scripted model can repeat one. LangGraph accepts duplicates, and both Send tasks run.

- **LG1a.** A turn holds `[issue_refund id=x, issue_refund id=x]`. The batch says `allowed`, then `denied (one-refund)`, and the ledger holds one refund effect. **Two refunds ran.**
- **LG1b.** A turn holds `[read_ticket id=d, issue_refund id=d]`. The refund is denied (`read-before-refund`: no read has been observed yet). It **runs** under the read's `allowed`, before any read happened.

The same weakness covers a middleware stack in which an outer `wrap_tool_call` rewrites `request.tool_call` (the doc says `Governor.wrap_tool_call` "fits there too"). The governor decides the AIMessage's call and executes the rewritten one.

**Evidence.** LG1a, LG1b.

**Fix.**
- Resolve the decision by **position and content**. Find the entry whose `(index, id, name, digest(args))` equals the executing `request.tool_call`. If none matches exactly, refuse, and never `execute`.
- Deny every call of a turn whose ids are missing or repeated. Say so in the witness ("duplicate tool_call id"), so the model can retry.
- Replace FO1's `return execute(request)` with a refusal.

### LG2: the binding signs chains it never built (SEC-EX1, re-opened)

`binding.py:149-161` (`_last_batch`), `:250-266` (`_fold`) and `:326-355` (`_export`). The latest `ToolMessage` whose `response_metadata["polyflow"]` has `v == 1` is taken as the truth:

- its `batch.run`, whose `ns`, `wf` and `run` are never compared with the thread being executed;
- its `head`;
- its `events`;
- its `guard` state.

`_fold` continues that chain. `_export` sees that the sink does not hold the run ("behind"), back-fills from `ledger_of(carried)`, verifies that the planted events chain (they do, since they were built with the public kernel), and signs the head with the deployment key.

**Who can plant it:**
- any caller of `invoke`/`stream` whose input may contain a `ToolMessage`. `add_messages` accepts one, and LangGraph Server's run API deserialises message dicts including `response_metadata`;
- anyone with `update_state`;
- a tool that returns a `Command` whose `messages` carry extra `ToolMessage`s. `_carry` passes through every message except the call's own.

**Evidence.** Test LG2: a chain planted on thread `attacker-thread` for `victim-thread/run-that-never-happened` (admission, a proposal and an `allowed` verdict) is back-filled, extended, and **signed** by the worker's key. The probe: `polyflow verify --allow-open` reports "OK (open) — consistent and signed through its last event". A `close()` on the attacker's thread appends a closure, and that makes it "closed-and-signed". The same planted batch can also carry `guard: init()`, which resets every rule (the LG3 effect, done on purpose).

**Fix.** This is the P9 SEC-EX1 and SEC-EX2 fix, applied to the binding:
- Only sign or back-fill a chain whose `run.ns == self.ns` and `run.wf == thread`, and whose seq-0 admission this thread wrote. Its `execution.thread` must equal `thread`, and its `run` must be one of this thread's checkpoint ids, which `get_state_history` can confirm.
- **Authenticate the carried batch.** Seal or MAC it (the P2.6 scheme, keyed per deployment, with `thread` and `run` in the AAD), and ignore any batch that does not open.
- Before deciding, compare the carried head with the sink's head for that run. If the sink holds a different continuation, **fail closed** (see LG4) instead of trusting the carried state.

---

## Major

### LG3: trimming the history resets the guard

`_last_batch` (`binding.py:149`) is the only source of prior state. When no governed `ToolMessage` is left in the list, `_build` takes the `prev is None` path: `guard.init()`, `run_id = base`, and a new admission with no `continues`. That happens after a trim, a summary, or `RemoveMessage(REMOVE_ALL_MESSAGES)`.

The trigger is ordinary: the history-persisting `pre_model_hook`, `trim_messages(..., start_on="human")`, or any summarisation node. The doc covers this case only as "a missing ToolMessage … is recorded as `ok: false`". That holds when *some* governed message survives, and not when none does.

**Evidence.** Test LG3. On one thread, the hook keeps messages from the last human message on. Conversation 1 reads, then refunds (allowed). Conversation 2 reads, then refunds: **allowed**, and the thread has two unlinked chains.

**Fix.**
- Keep the authoritative per-thread state (head, guard state, run) **outside the message list**, keyed by `(ns, thread)`: the sink's head plus a sealed guard snapshot, or LangGraph's `BaseStore`.
- The message metadata can stay as a cache, validated against that state.
- If neither exists for a thread that the sink already holds a chain for, refuse (fail closed). Never start `init()`.

### LG4: a time-travel fork re-spends a spent budget

`binding.py:367-378`. On a sink conflict, `_build(..., branch=True)` builds the linked chain from `prev` and `outcomes` as the fork sees them, and that is the guard state at the fork point. §3 of the doc says: "That chain carries the thread's guard state forward, so a spent budget stays spent (tested)". The only test is close-then-continue, where the fork point *is* the thread's latest state.

**Evidence.** Test LG4. A thread reads, then refunds. The test forks from the checkpoint after the read (`update_state(..., as_node="agent")` with a new refund call) and invokes. The branch is reported through `on_conflict`, and the refund is **allowed and runs**. `at-most`, `budget` and consumed `requires-prior` credits are all rolled back this way.

**Fix.** A branch must inherit the guard state of the **thread's latest head**, not of the fork point. Whatever ran, ran: at least the union of `n`, `ok` and spent budgets, and the latest taint. If the binding cannot compute that from the sink, a branch must deny every effect until an operator resolves it. Reporting the conflict is not enough when the next call is allowed anyway. Test it with a fork, not with a close.

### LG5: parallel subagents on one thread each get their own budget

The binding's unit is the message list, not the thread. Subagents running in one superstep each have their own list. The same holds for Send fan-outs that carry different states, and for subgraphs with their own `messages` channel. Each one folds its own guard state and starts its own chain, with `run` set to its own first checkpoint id and the same `wf`.

**Evidence.** Test LG5. A parent graph runs two `create_react_agent` subgraphs in parallel. Both use **the same governed `ToolNode`** (one governor), on one thread, under `one-refund` (at most 1). **Two refunds** run, and the thread gets two chains.

**Fix.** Same root as LG3. Keep the per-thread state outside the list, and serialise batches per thread: a per-`(ns, thread)` lock around decide-and-commit, re-reading the authoritative head inside the lock. Or document that the guard's scope is one agent's message list, and rename "thread" in the doc and in the admission.

### LG6: `messages_key` switches the guard off

`govern(**tool_node_kwargs)` forwards `messages_key` to `ToolNode` (`binding.py:481-495`), but `_messages` (`:121`) reads only `state["messages"]`. With any other key:

- `_calls_for` falls back to `[tool_call]`;
- `_last_batch` finds nothing;
- every call is a one-call batch on a fresh guard and a fresh chain.

**Evidence.** Test LG6: a custom `StateGraph` with `history` as the channel. Two refunds under at-most-1 **both run**, and the thread gets two chains.

**Fix.** Pass `messages_key` to the `Governor` and use it everywhere. Better still, at guard level, refuse to govern a call whose turn (the AIMessage that holds it) cannot be found in the state, instead of degrading to a one-call batch.

### LG7: two workers over one ledger directory corrupt the file

`sinks.py:155-162`: `FileSink._seen` caches a run's `{seq: hash}` once per instance. The class docstring says "One writer process per run directory", but the binding's own durability story is a thread resumed by *another* process. Test (d) does exactly that, with a second `FileSink` over the same directory. It passes only because the first worker never writes again.

With two long-lived workers (web servers, queue consumers):

1. worker 1 caches the head;
2. worker 2 appends;
3. worker 1's next batch sees the sink "behind" by its stale cache;
4. worker 1 back-fills from the carried state;
5. `partition_delta` against the stale cache finds nothing to skip.

Worker 2's events are then appended **again**.

**Evidence.** Test LG7. The stored seqs are `[0, 1, 2, 3, 4, 5, 3, 4, 5, 6, 7, 8, 9, 10, 11]`, and `polyflow verify` exits 1.

**Fix.**
- The FileSink re-reads the run file (or its size and mtime) before partitioning, and appends under an OS file lock (`O_APPEND` plus `fcntl`/`msvcrt` locking). Or `_export` re-reads `sink.head()` with the cache bypassed.
- Otherwise, state in the doc that a LangGraph deployment with more than one worker must use the HTTP sink (the service), and make the test (d) setup the negative case.

### LG8: replaying a completed step refunds again, and it is allowed

A LangGraph replay (`invoke(None, {"configurable": {"thread_id", "checkpoint_id": <old>}})`) re-executes the nodes after that checkpoint under a **new** checkpoint id. The batch is therefore decided at a new time and gets different hashes. It conflicts with the sink and is rebuilt as a branch from the guard state *before* the refund (LG4's mechanism), so the refund is **allowed** again.

The doc presents re-runs as "the **same** effect … the guard committed it once". That holds only for crash re-runs from the same checkpoint id. It does not hold for a replay, which operators use as "retry from here".

**Evidence.**
- Test LG8: after a completed read-then-refund, a replay from the `tools` checkpoint of `c3` runs the refund a second time.
- The probe: the original chain ends **open** at seq 7 (the `c3` effect, never observed). A second chain `continues` it at seq 4 and records `c3` as `allowed` again, with the same key `r/c3`.

**Fix.** Decide a batch from the *identity* of the model turn, not from the checkpoint it runs under: the AIMessage id and the tool-call ids, with the time taken from the checkpoint that *produced* the AIMessage (its `created_at` or id in the history). A replay then derives the same batch, and the sink skips it. Beyond that, the LG4 fix covers the budget. The ledger should also record a re-execution it cannot prevent (an `observation` with `rerun: true`), not hide it.

---

## Minor

- **LG9: model-chosen names are recorded in clear.**
  - `proposal.action = tool` (`binding.py:296`), `effect.activityType`, and the witness `candidate.target` hold the model's string verbatim, with no length bound. On Temporal these are code-defined activity types. Here they are model output, and an unknown tool name is still recorded (at G0, even as an effect).
  - Test LG9: a `ghp_…` token in the name is in the ledger.
  - Fix: record `redact(name, 200)`. Better, record unknown names as `"<unknown tool>"` plus a digest, and refuse them before recording at guard level.
- **LG10: the idempotency key is not injective** (`binding.py:315`).
  - Test LG10: `("acct/b", "c")` and `("acct", "b/c")` produce the same key, with different arguments.
  - Fix: a digest of `[ns, thread, run, effect seq]` (unique per recorded effect), or a canonical-JSON tuple. Let `argsDigest` travel with it, so a tool can refuse a key that is reused with different arguments.
- **LG11: missing identity degrades silently** (`binding.py:384-387`).
  - Two paths lead here:
    - A graph compiled without a checkpointer (the quickstart) has `thread_id = None`. Every conversation then files under `wf = "default"`, and idempotency keys become `default/<id>`.
    - `langgraph>=1.0,<2` admits langgraph 1.0.10 and 1.1.0, which require `langgraph-prebuilt>=1.0.8,<1.1.0`. Their runtimes have no `execution_info`, and prebuilt 1.0.8 already has `wrap_tool_call` (checked by unpacking the wheels; prebuilt 1.0.13 reads `runtime.execution_info` and would need a newer langgraph). Parallel tasks there get different random bases and wall-clock times, so they conflict and branch.
  - Test LG11 simulates the second case. (langgraph 1.0.0 with prebuilt 1.0.0 has no `wrap_tool_call` at all, so `govern` fails loudly there.)
  - Fix: at guard level, require `execution_info.thread_id` and `checkpoint_id`, and refuse otherwise. Pin the extra to `langgraph>=1.2,<2` and `langgraph-prebuilt>=1.1,<2`.
- **VF1: `verify` does not see what this binding breaks.**
  - `verifyBundle` checks the chain, the signatures and "some closure". A thread with an abandoned open chain plus a branch (LG8), or two unlinked chains (LG3, LG5), passes file by file.
  - Fix: a `polyflow verify --thread <dir>` mode that loads every chain of a `wf`, resolves `continues` links, and reports orphan and open chains. Add a structural check that every `effect` names a proposal whose verdict is `allowed`.
- **FO1: fail-open fallback.** `wrap_tool_call` and `awrap_tool_call` run `execute(request)` when the call is not in the batch (`binding.py:435`, and the async twin). Refuse instead (LG1's fix).
- **TM1: the ledger's clock.**
  - Verdict and effect are stamped with the checkpoint's time. After `interrupt_before=["tools"]` and a two-day human wait, the effect is dated two days early.
  - Observations use `_now_ms()` from whichever process ran the tool.
  - Nothing is loosened, because an older `at` makes `rate` windows stricter. But the times are not "when it happened".
  - Fix: document it, or stamp the effect with the executing process's time in the observation body (`startedAt`).

## Nits

- **LC1:** L7b and the `pyproject.toml` comment say certifi comes in "through httpx". The installed closure (`importlib.metadata` walk of `langgraph`) also brings **orjson 3.12.0** (`MPL-2.0 AND (Apache-2.0 OR MIT)`, through langsmith). certifi also comes in through `langchain-core → httpx` and `langsmith → requests`. Name orjson in L7b.
- **AS1:** the async path holds `self._lock` (a `threading.Lock`) around decide, export and FileSink I/O on the event loop (`binding.py:357-381`). It is documented. It serialises every parallel tool coroutine behind disk I/O. Use `asyncio.to_thread` for the export.

## Test gaps (claims without a test)

- **"A time-travel fork … carries the thread's guard state forward, so a spent budget stays spent (tested)"**: only close-then-continue is tested. LG4 and LG8 are the missing cases.
- **"Tools called elsewhere / subgraphs / parallel supersteps"**: no test has more than one message list per thread (LG5), a custom `messages_key` (LG6), trimming (LG3), or duplicate ids (LG1).
- **Multi-writer `FileSink`**: test (d) uses two sinks but writes with only one after the hand-over (LG7).
- **`Command` returns**: the documented limit ("the outcome is carried only when the Command's `messages` update contains that call's ToolMessage") has no test, nor does the Command-with-extra-ToolMessages path LG2 uses.
- **`langchain.agents.create_agent` middleware**: claimed to fit, and untested (the doc says so).

## What held up

- **The guard path is the kernel's.** `govern_effect` and `observe_effect` replay `guard.json` and `routed-guard.json` with identical decisions, witnesses, classifications and state digests. Routed case variants are denied (SEC-UL1). Escalations are refused, never allowed.
- **The sinks move is faithful.** A diff of the lines removed from `plugin.py` against `sinks.py` shows only the `_sign` → `sign_head` rename (with `_sign` kept as an alias), a docstring, and the `base64` import moved to module level. `partition_delta` (refuse the whole delta, SEC-PY1), `safe_component` (SEC-FS1/PY2), the root containment check and `_jsonl`'s lone-surrogate escaping are byte for byte unchanged. `plugin.py` re-exports every name, and its EX1 run-id check (`plugin.py:512-514`) is untouched. The full Python suite passes (483). Sealed headers were never in the moved code, and the binding does not have them (documented, and LG2's fix needs them).
- **Crash re-runs from the same checkpoint** dedupe as claimed. The re-run derives the same events, the sink skips them, and the budget is committed once (the existing test, reproduced).
- **The uuid6 time decode is correct**: `(time_high‖time_mid) << 12 | time_low`, minus the Gregorian epoch, in 100 ns ticks. It is stable per checkpoint. Non-uuid6 ids fall back to wall time, as documented.
- **Redaction of failure text** uses the kernel's `redact(…, 200)`, which is pinned by `parity.json`. Results go to the ledger as digests only. The raw result travels only in the checkpoint, which already holds the tool output.
- **No `temporalio` import**, checked in a clean interpreter.

## Status table: what the row should say

| Row | Suggested wording |
|---|---|
| P10 | LangGraph binding at G0/G1 **built and conformance-equal on the guard path**. **Not yet a guard:** decisions are resolved by model-chosen id (LG1). The carried state is unauthenticated and signed as found (LG2). The guard's scope is a message list, which trimming, forks, replays and parallel subagents reset or split (LG3–LG6, LG8). Multi-worker FileSink deployments corrupt the ledger (LG7). |

---

## Response


The root cause is fixed rather than patched call by call. The authority for a thread's chain head, guard state, decided turns and effect outcomes is now a **per-thread record keyed by `(ns, thread_id)`**. It sits beside the sink (`polyflow_langgraph/store.py`: `thread.state.json` next to a `FileSink`'s run files, written atomically under an OS file lock, or in memory next to a `MemorySink`). The binding no longer reads anything back from message metadata. What it attaches there (the effect id and the idempotency key) is a hint for people. Each model turn is decided once, under the thread's lock, against the thread's latest state, and bound to its exact calls. Every effect is observed when its tool returns.

LangGraph forced one choice. The guard state cannot be rebuilt from the ledger, because metric budgets read results and the ledger holds only digests. So the record is a store of its own, not the sink. A thread whose ledger exists but whose record is missing is refused, not re-initialised.

| Suite | Result |
|---|---|
| `test_review_p10.py` | 12/12 (LG1a's setup changed; see below) |
| `test_langgraph.py` | 19/19. Updated where the design changed (idempotency keys, `snapshot(thread)`, no branch report after a close), and 3 new tests |
| python (all) | 498 passed |

| # | Outcome | What changed |
|---|---|---|
| LG1 | fixed | A call runs only under the decided entry whose `(tool_call id, digest(name), digest(args))` equals the call being executed. Anything else is refused with `PolyflowRefused` and never executed. A turn whose ids repeat, or that has a call with no id, is refused **whole** (`polyflow:duplicate-call-id`, with a witness that tells the model to retry with unique ids). **Test changed, strictly stronger:** LG1a's setup expected `["allowed", "denied"]` and one refund. Both refunds are now denied and none runs (`verdicts == ["denied", "denied"]`, `refunds() == 0`). LG1b is unchanged. |
| LG2 | fixed | Nothing is read from message metadata, so a planted batch is inert. `_export` writes only events that this thread's record appended, and it refuses (and never signs) a segment whose `ns`/`wf` is not the record's own. The back-fill from carried state is gone. |
| LG3 | fixed | The guard state lives in the record, not the message list. After a trim, the next turn is decided against the thread's state, on the same chain. |
| LG4 | fixed | A fork's turn is decided against the thread's **latest** guard state, so a spent budget stays spent. It is also reported through `on_conflict`: the state holds an older decided turn but not the newest one. The doc states that this report is a heuristic (subagents that take turns on a thread can trigger it), and that governance does not depend on it. |
| LG5 | fixed | Subagents on one thread share the record. Their decisions serialise under its lock, so at-most-1 holds and the thread has one chain. |
| LG6 | fixed | `govern` passes `messages_key` to the governor. At guard level, a call whose model turn cannot be found under that key is refused; it no longer degrades to a one-call batch. |
| LG7 | fixed | Workers serialise on the thread record's OS file lock. `FileSink` re-reads a run file whose size changed under its cache, so a stale cache can no longer re-append another writer's events. The test's two workers now write a ledger that `polyflow verify` accepts. |
| LG8 | fixed | A turn is identified by its AIMessage id and its calls, not by the checkpoint it runs under. A replay finds the turn already decided. An effect that was already observed is **not** executed again: the recorded result is returned (for the last 256 effects of a thread; older ones get a `PolyflowReplay` refusal). A crash re-run of an unobserved effect still runs, as the same effect, and its observation records `attempts: n`. |
| LG9 | fixed | Names the node does not have are recorded as `<unknown tool>` plus `nameDigest`, and at guard level they are refused before any guard evaluation. Known names, route values and witness candidates are redacted and bounded to 128 characters. Denial reasons are bounded to 1000. |
| LG10 | fixed | `idempotencyKey = digest({run, effect})`: unique per recorded effect and injective. `argsDigest` travels beside it in the effect. |
| LG11 | fixed | With no `execution_info.thread_id` and `checkpoint_id`, the call is refused (`PolyflowRefused`) at both levels, unless `allow_unthreaded=True`, in which case each such call gets a chain of its own. The extra is pinned to what was tested: `langgraph>=1.2,<2` and `langgraph-prebuilt>=1.1,<2`. |
| VF1 | fixed | Python: `verify_thread(sink, thread)`. TypeScript: `polyflow verify --thread <dir>` (`verifyThread` in `packages/temporal/src/verify.mjs`) applies the same rules: every chain verifies (signed, or `--unsigned`); exactly one root; every `continues` link resolves to a **closure** of the thread, and none is continued twice; at most one open chain; every effect follows an `allowed` verdict; every observation names a known effect, once. It prints the root, the links and the open chain. `test_the_typescript_cli_verifies_a_thread_of_linked_chains` shows a linked thread passing and a rogue unlinked chain refused. |
| FO1 | fixed | The fallback `return execute(request)` is gone. An unmatched call is refused (see LG1). |
| TM1 | fixed | Proposal, verdict and effect carry the wall time of the decision, and the proposal also records the `checkpoint` id it ran under. The observation carries the time the tool returned. A human-in-the-loop pause no longer back-dates an effect. |
| LC1 | fixed | L7b and the `pyproject.toml` comment name orjson 3.12.0 (`MPL-2.0 AND (Apache-2.0 OR MIT)`, via langsmith) and both certifi paths (`langchain-core → httpx`, `langsmith → requests`). |
| AS1 | fixed | `awrap_tool_call` runs the decision, the record transaction and the sink write in `asyncio.to_thread`. The event loop is not blocked, and parallel tool coroutines no longer queue behind disk I/O. |

**Test gaps, answered.**

- Fork: LG4.
- Trimming, subagents, `messages_key`, duplicate ids: LG3, LG5, LG6 and LG1.
- Multiple writers: LG7.
- New tests for fail-closed behaviour and the thread-level check: a missing record over an existing ledger is refused; no checkpointer is refused unless explicitly allowed; `verify_thread` rejects unlinked chains and an effect without an `allowed` verdict.

**Still open:**

- `Command` returns with extra `ToolMessage`s are still untested. They can no longer plant state (LG2), but that path has no test.
- The `create_agent` middleware fit is still untested (`langchain` is not installed).
- A store for several hosts without a shared filesystem is not built. The doc says `FileThreadStore` needs working OS locks on one filesystem.
