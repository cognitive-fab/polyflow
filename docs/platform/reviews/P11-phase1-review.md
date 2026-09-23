# Review: P11 phase 0–1 (Temporal's `openai_agents/customer_service` on the Python G1 plugin)

Adversarial review of commit `0988bb8` on `platform/temporal-governance`:

- `platform/examples/upstream/` (pinned `samples-python@4e2f01e`, `check.mjs`);
- `platform/python/examples/temporal_samples/customer_service/` (the port, `policy.json`, `upstream.json`, `demo.py`, `README.md`);
- `platform/python/polyflow_temporal/plugin.py` (`_RunRef`, lazy chain, handlers waiting for the head, refusal after closure);
- `platform/packages/temporal/src/workflow-interceptors.mjs` (`closed` set with the closure, `refuseClosed`);
- `platform/python/tests/test_sample_customer_service.py`, `test_parity.py`, `parity_workflows.py`.

The reviewer changed no production code. Every claim below was checked by running it (`check.mjs`, `polyflow policy`, the two test suites) or by reading the installed SDK (`temporalio` 1.33.0, `openai-agents` 0.19.4, `mcp` 1.30.0 under `platform/python/.venv`).

## What was run

| Command | Result |
|---|---|
| `node platform/examples/upstream/check.mjs` | exit 0. `identical` for `workflows/customer_service_workflow.py`; `changed` for the other three with the declared `why`. |
| `node platform/packages/cli/bin/polyflow.mjs policy …/customer_service/policy.json` | exit 0. Admitted: five effects, route `Airline-stateless-call-tool-v2 → 0.tool_name`, rules `booking-after-lookup` (requires-prior, consume, bind any, deny), `one-seat-change` (at-most 1, deny), `model-rate` (30/60000 ms, deny), `escalation: null`, digest `sha256:87a013…`. |
| `cd platform/python && .venv/Scripts/python.exe -m pytest tests/test_sample_customer_service.py tests/test_parity.py -q -p no:cacheprovider` | **27 passed in 50.45s**, exit 0. |
| `cd platform/packages/temporal && npm test` | exit 0. `tests 109, pass 108, fail 0, cancelled 0, skipped 0, todo 1, duration_ms 493768.8`. The todo is the expected one: `DST1: no DST schedule forks the ledger … # DST1-R: replay-unstable event times in the first activation (see P9-review.md Response)`. |
| Upstream pin | `raw.githubusercontent.com/temporalio/samples-python/4e2f01e…/openai_agents/customer_service/workflows/customer_service_workflow.py` fetched and matches the pinned copy (same `run()` body, same validator, imports only `from temporalio import workflow`). `temporalio` 1.33.0 has no `temporalio.openai_agents` module, so the README's "unreleased import path" claim is true for the installed SDK. |

## Findings

### Blockers

None. Nothing in this commit loses an effect from the record or lets a refused call run. The two majors below are about (1) a behavioural change the plugin now imposes on every continued execution, and (2) the honesty of the demo and the manifest, which is the stated deliverable of this phase.

### Major

**M1. In a continued execution, signal and Update handler bodies now run *after* the workflow function's first synchronous segment, reversing Temporal's ordering.**
`platform/python/polyflow_temporal/plugin.py:270-273` (`_RunRef.started`), `:471-490` (`handle_signal`, `handle_update_handler`).

The Python SDK applies jobs in the order patches → signals+updates → initialize (`temporalio/worker/_workflow_instance.py:476-512`), so handler tasks are created and stepped before the primary task: a handler's body runs up to its first `await` *before* `run()` starts. That is the guarantee Temporal gives for signal-with-start and for signals carried across Continue-as-New, and it is why `@workflow.init` exists. The plugin now inserts `await wait_condition(lambda: self.run is not None)` at the top of every handler when `continued_run_id` is set. The handler suspends, the primary task runs `execute_workflow` (which sets `run`) and then the workflow function's first synchronous segment, and only at the end of that `_run_once` pass is the condition satisfied and the handler resumed. On a fresh execution the order is Temporal's; on a continued one it is inverted. It is deterministic (the same on replay), so nothing throws; the semantics simply change.

Failure scenario: a workflow whose `run()` reads state a handler sets before its first await, e.g. `run(self, state)` doing `if not self.pending and self.drained: return "done"` or `self.items.extend(state.items)` before a loop, with a `stop` signal sent while the previous execution was continuing-as-new (Temporal delivers it to the new run's first WFT). On plain Temporal and on a fresh run the handler runs first and `run()` sees the flag; under this plugin the continued execution's `run()` runs first, decides on stale state, and the handler mutates state the function has already read. Concretely for the sample: the client's `execute_update` racing the hand-over is Temporal's own edge (`test_parity.py:185` says so), but the plugin now adds a second, plugin-specific edge on top of it for every governed workflow, not just this one.

The wait is unnecessary. `temporalio.workflow.info().headers` (`temporalio/workflow/_context.py:91`) carries the start headers, `HEAD_HEADER` included, from the first activation on, before `execute_workflow` runs. `_RunRef.get()` can open the handed-over head from there (the same `open_header(..., expect={"runId": info.continued_run_id, "purpose": "head"})` that `execute_workflow` does at `:449`), create `_Run(config, resume)` synchronously, and `execute_workflow` reuses it exactly as it already does for the fresh case. Then `started()` and `wait_condition` go, handler ordering is Temporal's on both sides of the hand-over, and the `RuntimeError` at `:266` (which today turns a `workflow.start_activity` from `__init__` in a continued run into a permanent task failure) disappears too. The parity test `test_an_update_handler_may_run_before_the_workflow_function_on_both_sides_of_continue_as_new` should then also assert the order (handler body before `run()`'s first segment) on the continued side; today it only asserts that the effect lands in one chain.

**M2. The demo's three refusals all refuse behaviour the prompt or the customer asked for; the README calls it "the conversation a hallucinating or looping agent has".**
`platform/python/examples/temporal_samples/customer_service/demo.py:74-93`, `README.md:63-80`, `customer_service.py:71-78`.

- Refusal 1 (`booking-after-lookup`): the Seat Booking Agent's instructions, unchanged from upstream, are "1. Ask for their confirmation number. 2. Ask the customer what their desired seat number is. 3. Use the update seat tool". There is no step "look the booking up first"; upstream has no lookup tool at all. The port adds `get_booking` to the server and a rule requiring it, but tells the agent nothing. A real model calling `update_seat` first is following its routine, not hallucinating. The policy fights the prompt, and the demo scripts the prompt's behaviour as misbehaviour.
- Refusal 2 (`one-seat-change`, n=1): "Actually, make it 14C" is a legitimate second request from the customer. Nothing looped. The README's rule table says "a second needs a person", but in Python nobody is asked (escalation is a refusal, README line 95-98 says so honestly); the customer is simply told no.
- Refusal 3 (`cancel_booking` undeclared): the tool exists only because the port added it to `airline_server.py:78,94-96` to be refused, and the model calls it because the customer said "cancel the booking".

So the before/after is: before, the agent does what it was told; after, it is refused three times and the customer gets one of three things they asked for. That may be the intended governance posture, but it is not evidence that the guard catches a hallucinating or looping agent, and the README should not say it is. Two honest options: (a) keep the policy and reword the README and the `demo.py` docstring to say what it demonstrates (a policy that overrides the prompt, one change per conversation without a person, an unnamed tool never reaches the server); (b) make the script show real misbehaviour the *unchanged* prompt does not license: a model that calls `update_seat` twice for the same request (retry loop, `at-most` catches it), or invents a tool name (`unlabelled`), while the instructed path (lookup then update) goes through. Option (b) would also let the seat agent's instructions stay untouched *and* be honoured.

Related, on the manifest: `upstream.json:6` says "agents, handoffs and context unchanged". The `AirlineAgentContext` class is unchanged, but upstream's `update_seat` wrote `confirmation_number` and `seat_number` into it and asserted the handoff's `flight_number` (`upstream/.../customer_service.py:59-63`); the port never writes to the context again, and the handoff's `FLT-xxx` is dead state (the server's booking says `FLT-512`). The context the workflow carries across Continue-as-New is now permanently empty. "context unchanged" is true of the type and false of its use; say "context type unchanged; the tools no longer populate it".

### Minor

**m1. The undeclared MCP activities the SDK can emit are not named, and `unlabelled: deny` will refuse them if they ever are.**
`policy.json:8-11`; `temporalio/contrib/openai_agents/_mcp.py:90-131,221-235`.
The stateless reference emits `Airline-stateless-list-tools`, `-call-tool-v2`, `-list-prompts`, `-get-prompt-v2` (the deprecated `-call-tool` / `-get-prompt` exist as activities but the workflow-side reference never schedules them; the stateful variants need `stateful_mcp_server`, which the port does not use). The route key and `0.tool_name` are right: the argument is one `_StatelessCallToolsArguments(tool_name, …)` dataclass, `_jsonable` turns it into `[{"tool_name": …}]`, and the test asserts the routed names. `faq_lookup_tool` and `list-tools` are declared, so the FAQ path is not refused (the test only exercises the seat path; a one-line FAQ turn in the script would prove it). `list_prompts`/`get_prompt` are not called by the Agents SDK's run loop in 0.19.4 (`agents/run_internal/run_loop.py` only calls the agent's own `get_prompt`), so nothing is refused today. Name them anyway (`kind: discover`) or the README should say why not: the next SDK that lists prompts at run start will make every turn fail with `unlabelled`, and the README's "the route key is the one thing to re-check" understates what can change.

**m2. `_govern` reads `run.closed` after `get()`, but `handle_signal` records a proposal into a closed run silently.**
`plugin.py:471-475`. After `_close` (closed=True) a signal handler still runs (`run.append` returns `None`), calls `guard.signal` on state nobody will carry, and its body may then call `start_activity`, which is refused (`:290-296`) — correct. But the signal's *arrival* is not in the record and not refused, so a `never-after` rule that keys on a signal (`rules.py:191`) sees it in the in-memory state only. Harmless for the outcome (the execution is closed), but the docstring "the closure is its last event" now hides a class of events rather than refusing them; the same holds in TS (`workflow-interceptors.mjs:443-449`, `append` is a no-op once `closed`). Document, or have `handle_signal` skip the guard when closed.

**m3. No test covers the post-closure refusal in either language.**
`grep "after this execution closed"` matches only the two source files. The commit message says "both plugins now refuse it"; nothing asserts it. A workflow that returns while an Update handler is awaiting an activity, then schedules another one, would pin the message, the `PolyflowDenied` type and — importantly — that the flush activity still bypasses the check (`plugin.py:334-336` checks `run.flushing` before `_govern`; TS `scheduleActivity` checks `flushing` before `governed`, so the bypass is intact in both; verified by reading, not by a test).

**m4. The TS `drainAll` loop's rationale is now dead.**
`workflow-interceptors.mjs:145-157,160-164`. With `closed = true` set before `drainAll()`, `append` is a no-op during the flush, so "the loop in drainAll picks up anything that lands while it is in flight" (comment at `:160-161` and the L4 remark at `:148-149`) can no longer happen: the loop only re-runs if a *previous* flush failed to drain. Test T5 (`review-temporal.test.mjs:139`) passes for the stronger reason (nothing is appended after the closure), which is the Python behaviour and the right one; update the comments so the next reader does not look for the late-append path.

**m5. `handle_update_handler` records nothing about the Update itself.**
`plugin.py:483-490`. A signal's arrival is a `proposal` with `source: 'signal'` (`:473`); an Update's is not. In this sample every customer message is an Update, so the chain has model calls and tools but no event that says a turn began, and nothing to correlate a refusal with the message that provoked it. TS has the same gap (`inbound.handleSignal` only). Worth a `proposal` with `source: 'update'` and the update name, in both plugins, before this shape is pinned by conformance.

**m6. Licence notice for the vendored MIT files.**
`platform/examples/upstream/samples-python@4e2f01e/LICENSE` and `SOURCE.md` are present and correct (MIT, Temporal Technologies). The port directory, however, contains a byte-identical copy (`workflows/customer_service_workflow.py`) and three near-copies with no notice of their own; the only pointer is the README's link to the upstream directory. MIT asks that the notice accompany "all copies or substantial portions". `pyproject.toml` does not package `examples/`, so the wheel is clean; the repository is not quite. A one-line header (`# From temporalio/samples-python@4e2f01e, MIT — see platform/examples/upstream/`) on the three changed files, and a `NOTICE` beside the identical one (a header would break byte-identity), closes it. Add a row to `P9-licence-audit.md`.

**m7. `sys.path` and module naming.**
`demo.py:35-36`, `tests/test_sample_customer_service.py:33-35`. The port's package is `openai_agents`, which is also the *distribution* name of the Agents SDK (`openai_agents-0.19.4.dist-info`; its importable module is `agents`), and `platform/python/examples/openai_agents/` is a sibling example directory. No collision today: the dist-info is not importable, and `test_s2_openai_agents.py` puts `examples/openai_agents/` itself on `sys.path` (`run`, `tickets_server`), not `examples/`. But `demo` and `run` are generic top-level names both pushed at `sys.path[0]` in one pytest session; the first `import demo` wins for the process. Fine while there is one port; the second port (phase 2/3 are TypeScript, so probably fine) should use a unique module name or a package. `demo.py:36` inserts the `python/` dir at index 1 "when polyflow_temporal is not installed": this also shadows an installed `polyflow_temporal` with the checkout — intended for a dev tree, surprising for a user who ran `pip install`.

**m8. `check.mjs` on Windows.**
`check.mjs:34` normalises `\r\n`, so a CRLF checkout compares equal (the working copy of `check.mjs` itself is CRLF while `.gitattributes` says `eol=lf`; git's clean filter hides it). It does not strip a BOM or normalise a lone `\r`; acceptable. `manifests()` walks the whole `platform/` tree on every run (skipping `node_modules`, `.venv`, `upstream`, dot-dirs) and `statSync` will throw on a dangling junction; cheap to guard. The test at `test_sample_customer_service.py:52` greps the human-readable line `identical  openai_agents/…` — a formatting change breaks the test without changing the check; assert on exit code and on the manifest instead, or have `check.mjs` accept `--json`.

**m9. Test isolation of `BOOKINGS` / `SEAT_CHANGES`.**
`airline_server.py:27-32`, test `:60-61`. Module-level state in a server the SDK documents as "stateless … a new server each time so that state is not shared between workflow runs" (`_mcp.py:154-155`). The test resets `SEAT_CHANGES` and seat `9C` by hand; it does not restore a cancelled booking (`BOOKINGS["ABC123"]` would `KeyError` at `:61` if a prior test in the session ever let `cancel_booking` through, e.g. a future G0 run of the same demo). Reset the whole dict from a constant, and note in the docstring that the module state is the demo's "database".

**m10. Small README inaccuracies.**
`README.md:16` says `customer_service.py` "changed in one place"; it changed in five (import, added import, two tools removed, `airline_tools()` added, two `tools=` → `mcp_servers=`). `README.md:17` "one line" for `run_worker.py` is three imports, a constant and the provider as well (`upstream.json:7` says this correctly). `README.md:85-86` prints "22 head(s)" from one run; counts vary with timing (the parity test's flush loop), so present the verify output as an example, not a number.

## Answers to the questions asked

1. **Byte-identical claim.** True and mechanically enforced for the workflow file (checked against GitHub at the pinned commit). The manifest's `why` strings are honest except "context unchanged" (M2, last paragraph). `check.mjs` also refuses the opposite drift (a file declared changed that is identical), which is the right shape.
2. **Policy.** `Airline-stateless-call-tool-v2` is the exact activity type `_StatelessMCPServerReference.call_tool` schedules (`_mcp.py:106-113`) and `0.tool_name` is the right path into its single dataclass argument. The admitted output is as expected; `unlabelled: deny` is explicit (the Python plugin does not default it, manual §8.1).
3. **Coverage.** `faq_lookup_tool` (`faq`) and `-list-tools` (`discover`) are declared, so a FAQ turn is not refused; `-list-prompts` / `-get-prompt-v2` are not declared and not emitted by this SDK version (m1). Stateful and deprecated variants are not reachable from this port.
4. **Plugin.** Chain creation on first use is deterministic: job order within an activation is fixed by core and re-applied identically on replay, `_now_ms` is workflow time, and the parity test runs with `max_cached_workflows=0`. `wait_condition` in an interceptor is legal workflow code and cannot deadlock here (the primary task is created in the same activation and sets `run` synchronously, before any await), but it reorders handlers on a continued execution (M1). A signal in the first task of a fresh execution creates the chain and records the proposal; in a continued one it waits (M1). Refusal after closure is correct and consistent with Temporal's TMPRL1102 (a handler outliving the workflow function is already abandoned by the SDK, so no legitimate effect is refused); the flush bypass survives in both languages; the `closed = true` reorder in TS turns the drainAll loop's comment into fiction (m4) and is otherwise the Python behaviour.
5. **Tests.** Python: 27 passed in 50.45s, exit 0. TypeScript: 109 tests, 108 pass, 0 fail, 1 todo (DST1-R, expected), exit 0.
6. **Demo realism.** Stacked (M2). The README is accurate about escalation being a refusal in Python.
7. **Other.** Licence (m6), `sys.path` (m7), CRLF (m8), isolation (m9).

## What is right

- The seam is the right one. Moving the effectful tool onto an MCP server whose calls are activities is Temporal's own guidance and the only place a policy can see a seat change; the workflow file stays byte-identical and `check.mjs` makes that a test, not a sentence.
- The route mechanism works end to end on the real SDK shape: the dataclass argument is read as it travels (`_jsonable` through the worker's payload converter), the routed name appears in the `effect` event, a routed-but-undeclared tool is denied regardless of `unlabelled`, and the server never sees it (`assert "ABC123" in BOOKINGS`).
- The refusal is legible to the agent: the `PolyflowDenied` error lands as the tool's output through the Agents SDK's `failure_error_function`, so the model re-plans (the test checks what the model was shown, `model.inputs[3]`), and the chain records the witness.
- The lazy chain fixes a real bug: before this commit an Update-driven workflow's first effect was scheduled with `run_ref[0] is None`, and would have failed the task. The fresh-execution path is clean: `get()` creates, `execute_workflow` reuses, the admission is the first event, and the parity test proves one chain across the hand-over with `max_cached_workflows=0`.
- The post-closure refusal closes a real hole (an effect after the closure was silently off the record) and does so fail-closed, in both plugins, with the flush path exempted by a private flag rather than by name.
- Pinning upstream sources with `SOURCE.md` and the repository's `LICENSE`, and refusing manifest drift in both directions, is the right discipline for the two TypeScript ports to follow.
- The tests run offline: scripted model through the SDK's own `ResponseBuilders`, in-process server, local dev server, and the TypeScript CLI admits the policy and verifies the ledger, so the cross-language claim is exercised rather than assumed.

## Response (same session)

| Finding | Action |
|---|---|
| M1 handler ordering on a continued execution | **Fixed.** `_RunRef.get()` opens the handed-over head synchronously from `workflow.info().headers` (`_resume_from`); `started()` and the wait are gone, `execute_workflow` shares the same path. Handler ordering is Temporal's again. `test_parity.py` (Update on both sides of continue-as-new) and the sample test pass. |
| M2 the demo stacks the deck | **Reframed, not re-scripted.** The README now says what the script is (each rule hit once, the prompt knowing none of them, which is the point: the policy holds whatever the prompt says), calls `one-seat-change` the operator's limit for this demo and says the TypeScript plugin would park the call instead, and says `cancel_booking` is a server tool the operator never granted. `upstream.json` says the context type stays but the tools no longer write it. |
| m1 prompt activities | **Fixed.** `Airline-stateless-list-prompts` and `-get-prompt-v2` are declared `discover`. |
| m2 a signal into a closed run | Open. The proposal cannot be recorded after the closure; refusing a signal has no caller to refuse to. The effect it might schedule is refused (post-closure rule). Documented here. |
| m3 no test of the post-closure refusal | Open. The path is reachable only when Temporal runs a handler job after the primary task's continuation inside one activation (seen in the TMPRL1102 trace that found it); a client cannot force two jobs into one activation, so a deterministic test needs a workflow-instance harness. Carried to the P11 close-out review. |
| m4 dead `drainAll` rationale | **Fixed** (comment). |
| m5 Updates record no proposal | Open by design for now: the TypeScript G1 interceptor records signals, not Updates, and the two ledgers are held to the same conformance corpus. Adding an Update proposal is a joint change (both plugins, a vector); noted for the close-out. |
| m6 licence notice in the port | **Fixed.** `NOTICE.md` in the port directory. |
| m7 `sys.path`, module names | Accepted as sample scaffolding; the package name is upstream's layout, which the byte-identical workflow file imports. |
| m8 `check.mjs` on Windows | Accepted; CRLF normalised, BOM not (no upstream file has one). |
| m9 module-level server state | Accepted for a stateless in-process stand-in; the test resets what it asserts on. |
| m10 README wording | **Fixed** ("changed in its tool wiring only", "the plugin", the verify excerpt no longer quotes one run's counts). |
