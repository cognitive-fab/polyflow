"""PolyflowPlugin for the Temporal Python SDK — G0 observe and G1 guard.

The Python half of the platform (technical spec §10): the same ledger and the
same guard as the TypeScript plugin, ported and pinned byte for byte by the
conformance corpus, so a ledger written by a Python worker verifies under the
TypeScript `polyflow verify`, and a policy decides the same effect the same
way in both languages. Policies arrive admitted by the TypeScript toolchain.

Inside the workflow only pure things run: the guard decides, the ledger
chains, and the delta rides on the headers of activities the workflow was
going to schedule anyway. Signing and export happen in the activity
interceptor, where I/O belongs. Rules carried over from the TypeScript
reviews:

- a workflow TASK failure (an exception the SDK does not turn into a workflow
  failure: not a FailureError, not a declared ``failure_exception_types``)
  issues no command of ours, so the fixed code still replays;
- a close is a return, a Temporal failure, a declared failure type, a
  cancellation, or a Continue-as-New: each ends with a closure;
- bookkeeping never changes the workflow's outcome: a failed flush is
  swallowed and the missing closure is what a verifier reports;
- a chain is keyed by the run that started it, and handed forward, with the
  guard's state, only by Continue-as-New;
- every outgoing effect is governed: activities, local activities, child
  workflows, signals to other workflows, and Nexus operations;
- failure text is redacted before it is recorded; results are read as they
  travel (the payload converter's JSON), so a dataclass spends a budget.

Not yet in the Python plugin (tracked in the plan): escalation to a person
(an escalation is refused here, never silently allowed), governed workflows
(G2), the memo head.
"""

from __future__ import annotations

import asyncio
import dataclasses
import inspect
import json
import os
import re
from datetime import timedelta
from pathlib import Path
from typing import Any

import temporalio.activity
import temporalio.workflow
import temporalio.converter
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError, FailureError, is_cancelled_exception
from temporalio.plugin import SimplePlugin
from temporalio.worker import (
    ActivityInboundInterceptor,
    ContinueAsNewInput,
    ExecuteActivityInput,
    ExecuteWorkflowInput,
    HandleSignalInput,
    HandleUpdateInput,
    Interceptor,
    SignalChildWorkflowInput,
    SignalExternalWorkflowInput,
    StartActivityInput,
    StartChildWorkflowInput,
    StartLocalActivityInput,
    StartNexusOperationInput,
    WorkflowInboundInterceptor,
    WorkflowInterceptorClassInput,
    WorkflowOutboundInterceptor,
)

from .canonical import digest
from .ledger import Ledger, genesis, verify_chain
from .redact import redact
from .sealed import check_header_key, open_header, seal_header
from .rules import Guard, check_admitted, classify, route_target
# Sinks and head signing are engine-neutral (the LangGraph binding writes through
# them too); re-exported here, where they have always been imported from.
from .sinks import (  # noqa: F401
    FileSink, MemorySink, _contiguous_head, _jsonl, _load_signer, _no_write, _sign, head_message,
    partition_delta, safe_component, sign_head,
)

LEDGER_HEADER = "polyflow-ledger"
HEAD_HEADER = "polyflow-ledger-head"
FLUSH_ACTIVITY = "polyflow.flush"
CLOSE_FLUSHES = 3


def _converter():
    try:
        return temporalio.workflow.payload_converter()
    except Exception:  # noqa: BLE001 — outside a workflow (tests, the activity side)
        return temporalio.converter.default().payload_converter


def _jsonable(value):
    """The value as it travels: JSON-shaped, as the TypeScript side sees it.

    A Python activity returns a dataclass or a pydantic model far more often
    than a dict (review PY3). The worker's own payload converter says what it
    is on the wire, so a budget reads the same fields in both languages.
    """
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    try:
        conv = _converter()
        return conv.from_payload(conv.to_payload(value))
    except Exception:  # noqa: BLE001 — fall back to the common shapes
        pass
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        try:
            return dump(mode="json")
        except Exception:  # noqa: BLE001
            return None
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    return None


def _digest_json(value) -> str:
    try:
        return digest(value)
    except Exception:  # noqa: BLE001 — a digest must never fail the workflow
        return "sha256:unhashable"


def _digest_of(value) -> str:
    return _digest_json(_jsonable(value))


def _args_digest(args) -> str:
    return _digest_of(list(args))


def _failure_text(err) -> str:
    """Failure text for the record: redacted before it is written, then truncated (review PY2)."""
    if isinstance(err, asyncio.CancelledError):
        return "cancelled"
    cause = getattr(err, "cause", None) or err
    msg = getattr(cause, "message", None)
    if not isinstance(msg, str) or not msg:
        msg = str(cause) or ("cancelled" if is_cancelled_exception(err) else "failed")
    return redact(msg, 200)


def _now_ms() -> int:
    return int(temporalio.workflow.time() * 1000)


def _runtime():
    try:
        return temporalio.workflow._Runtime.maybe_current()  # noqa: SLF001
    except Exception:  # noqa: BLE001
        return None


def _evicting() -> bool:
    """The worker is tearing the workflow out of its cache: not a close of the workflow."""
    return bool(getattr(_runtime(), "_deleting", False))


def _closes_workflow(err: BaseException) -> bool:
    """Does this exception close the WORKFLOW (not just fail its task)? Asks the SDK,
    so `workflow_failure_exception_types` and `failure_exception_types` count (review D1)."""
    if isinstance(err, asyncio.CancelledError):
        return True  # the SDK turns it into a Temporal CancelledError, a failure
    fn = getattr(_runtime(), "workflow_is_failure_exception", None)
    if callable(fn):
        try:
            return bool(fn(err))
        except Exception:  # noqa: BLE001
            pass
    return isinstance(err, (FailureError, asyncio.TimeoutError))


def _outcome_of(err: BaseException) -> str:
    requested = getattr(_runtime(), "_cancel_reason", True) is not None
    return "cancelled" if requested and is_cancelled_exception(err) else "failed"


class _Run:
    """Per-execution state: the ledger and the guard. Pure; lives in workflow code."""

    def __init__(self, config: dict, resume: dict | None = None):
        info = temporalio.workflow.info()
        self.config = config
        self.policy = config.get("policy")
        self.guard = Guard(self.policy) if self.policy else None
        self.state = self.guard.init() if self.guard else None
        if resume:
            # The chain is handed over by Continue-as-New, not restarted: same
            # identity, same head, and the guard's state (budgets, at-most, taint,
            # rate windows) belongs to the chain, not to one execution (review GC).
            self.ledger = Ledger(resume["run"], {"seq": resume["seq"], "hash": resume["hash"]})
            if self.guard and isinstance(resume.get("guard"), dict):
                self.state = resume["guard"]
        else:
            self.ledger = Ledger({"ns": info.namespace, "wf": info.workflow_id, "run": info.run_id})
            admission = {"level": config["level"], "policy": None}
            if self.policy:
                admission["policy"] = {"name": self.policy["policy"], "version": self.policy["version"], "digest": self.policy["digest"]}
            admission["execution"] = {"runId": info.run_id, "attempt": info.attempt}
            self.ledger.append("admission", admission, _now_ms())
        self.flushing = False
        self.closed = False

    def append(self, kind, body):
        return None if self.closed else self.ledger.append(kind, body, _now_ms())

    def close(self, outcome: str):
        """Append the closure and stop recording: the closure is this execution's last event."""
        if not self.closed:
            self.append("closure", {"outcome": outcome})
            self.closed = True

    def sealed(self, value, purpose: str, seq: int):
        """A header body, sealed under the worker's data key when one is configured
        (plan P2.6; NFR-7): the same envelope the TypeScript plugin writes."""
        key = self.config.get("header_key")
        if not key:
            return value
        return seal_header(value, key, run_id=temporalio.workflow.info().run_id, purpose=purpose, seq=seq)

    def carry(self, headers):
        events = self.ledger.drain()
        if not events:
            return headers
        head = self.ledger.head()
        payload = _converter().to_payload(self.sealed({"events": events, "head": head}, "ledger", head["seq"]))
        return {**headers, LEDGER_HEADER: payload}


def _settled(observe):
    """A done-callback recording how an effect's task ended, cancellation included (review PY5)."""
    def cb(task):
        if task.cancelled():
            observe(False, err=asyncio.CancelledError())
            return
        err = task.exception()
        if err is not None:
            observe(False, err=err)
        else:
            observe(True, task.result())
    return cb


class _RunRef:
    """The execution's chain, shared by the inbound and outbound interceptors.

    A signal or Update handler may run BEFORE the workflow function in the
    first workflow task (the sample `openai_agents/customer_service` is driven
    entirely by Updates), so the chain cannot wait for execute_workflow to
    exist: a fresh execution creates it on first use. A continued execution
    cannot (its head arrives in execute_workflow's headers), so its handlers
    wait for the workflow function to start, which happens in the same task.
    """

    def __init__(self, config: dict):
        self._config = config
        self.run: _Run | None = None

    def get(self) -> _Run:
        if self.run is None:
            if temporalio.workflow.info().continued_run_id:
                raise RuntimeError("polyflow: an effect before the continued execution received its head")
            self.run = _Run(self._config, None)
        return self.run

    async def started(self) -> _Run:
        if self.run is None and temporalio.workflow.info().continued_run_id:
            await temporalio.workflow.wait_condition(lambda: self.run is not None)
        return self.get()


class _Outbound(WorkflowOutboundInterceptor):
    def __init__(self, next: WorkflowOutboundInterceptor, run_ref: _RunRef):
        super().__init__(next)
        self._run_ref = run_ref

    def _govern(self, via: str, target: str, args, *, listed: bool = True):
        """Record an outgoing effect and decide it. Returns the observer for its outcome,
        or raises the refusal, which the workflow reads like any tool error.

        ``args`` is the call's argument list (or, ``listed=False``, its single
        input), read as it travels. A policy may ROUTE an activity that carries
        many tools (the OpenAI Agents SDK's ``<server>-call-tool-v2``): it is then
        classified by the value at the route's path in the arguments (P7.3a)."""
        run: _Run = self._run_ref.get()
        if run.closed:
            # A handler still running after the workflow function continued-as-new
            # or returned (Temporal warns about it, TMPRL1102) would make an effect
            # this execution's record cannot hold: the closure is its last event.
            # Refuse it, so nothing happens off the record.
            raise ApplicationError(f"'{target}' after this execution closed: an effect with no record is refused",
                                   type="PolyflowDenied", non_retryable=True)
        shaped = _jsonable(list(args) if listed else args)
        a_digest = _digest_json(shaped)
        routed = route_target(run.policy, target, shaped if listed else None) if run.policy else target
        cls = classify(run.policy, routed) if run.policy else {"kind": target, "class": "unlabelled", "labels": [], "declared": True}
        at = _now_ms()
        proposal = run.append("proposal", {"source": "workflow", "action": target, "dataDigest": a_digest})
        pid = f"p{proposal['seq']}"
        c = {**cls, "target": target, "argsDigest": a_digest, "at": at, "proposal": pid}
        d = run.guard.decide(run.state, c) if run.guard else {"outcome": "allow", "rules": []}
        if d["outcome"] != "allow":
            # An escalation needs a person, and this build has no inbox: refuse, never allow.
            message = d.get("message") or f"denied by {', '.join(d['rules'])}"
            if d["outcome"] == "escalate":
                message = f"escalation required ({message}); this worker cannot ask a person yet, so the effect is refused"
            run.append("verdict", {"proposal": pid, "outcome": "denied", "rules": d["rules"], "witness": d.get("witness"), "reason": message})
            raise ApplicationError(message, d.get("witness"), type="PolyflowDenied", non_retryable=True)
        run.append("verdict", {"proposal": pid, "outcome": "allowed", "rules": d["rules"]})
        if run.guard:
            run.state = run.guard.commit(run.state, c, d)
        guard_seq = run.state["seq"] if run.guard else None
        info = temporalio.workflow.info()
        eid = f"e{run.ledger.head()['seq'] + 1}"
        run.append("effect", {"id": eid, "proposal": pid, "kind": cls["kind"], "class": cls["class"], "via": via,
                              "activityType": target, **({"route": routed} if routed != target else {}), "argsDigest": a_digest, "idempotencyKey": f"{info.workflow_id}/{info.run_id}/{target}/{pid}"})

        def observe(ok, result=None, err=None):
            if ok:
                run.append("observation", {"effect": eid, "ok": True, "resultDigest": _digest_of(result)})
            else:
                run.append("observation", {"effect": eid, "ok": False, "error": _failure_text(err)})
            if run.guard:
                run.state = run.guard.observe(run.state, cls["kind"], bool(ok), labels=cls["labels"],
                                              result=_jsonable(result) if ok else None, seq=guard_seq)

        return observe

    def start_activity(self, input: StartActivityInput):
        run: _Run = self._run_ref.get()
        if run.flushing and input.activity == FLUSH_ACTIVITY:
            return self.next.start_activity(dataclasses.replace(input, headers=run.carry(input.headers)))
        observe = self._govern("activity", input.activity, input.args)
        handle = self.next.start_activity(dataclasses.replace(input, headers=run.carry(input.headers)))
        handle.add_done_callback(_settled(observe))
        return handle

    def start_local_activity(self, input: StartLocalActivityInput):
        # Local activities record a marker, not their headers: nothing rides here.
        observe = self._govern("local-activity", input.activity, input.args)
        handle = self.next.start_local_activity(input)
        handle.add_done_callback(_settled(observe))
        return handle

    # One workflow starting, signalling or calling another is an effect like
    # any other (FR-GRD.1; review PY1): otherwise an obvious way around a policy.

    async def start_child_workflow(self, input: StartChildWorkflowInput):
        # Only activities carry the ledger: a child's start header reaches history, never the sink.
        observe = self._govern("child-workflow", input.workflow, input.args)
        try:
            handle = await self.next.start_child_workflow(input)
        except BaseException as err:
            observe(False, err=err)
            raise
        handle.add_done_callback(_settled(observe))  # the CHILD's outcome, not its start
        return handle

    async def _signal(self, input, send):
        observe = self._govern("signal", f"signal:{input.signal}", input.args)
        try:
            await send(input)
        except BaseException as err:
            observe(False, err=err)
            raise
        observe(True, None)

    async def signal_external_workflow(self, input: SignalExternalWorkflowInput) -> None:
        await self._signal(input, self.next.signal_external_workflow)

    async def signal_child_workflow(self, input: SignalChildWorkflowInput) -> None:
        await self._signal(input, self.next.signal_child_workflow)

    async def start_nexus_operation(self, input: StartNexusOperationInput):
        observe = self._govern("nexus", f"nexus:{input.service}/{input.operation_name}", input.input, listed=False)
        try:
            handle = await self.next.start_nexus_operation(input)
        except BaseException as err:
            observe(False, err=err)
            raise
        task = getattr(handle, "_task", None)  # the SDK's handle wraps the operation's task
        if isinstance(task, asyncio.Future):
            task.add_done_callback(_settled(observe))
        return handle

    def continue_as_new(self, input: ContinueAsNewInput):
        # The chain is handed over, not restarted: close this execution's part,
        # then give the next execution the head, the chain's identity and the
        # guard's state. The flush happens in execute_workflow, on the way out.
        run: _Run = self._run_ref.run
        if run is not None and not run.closed:
            run.close("continued-as-new")
            carried = {"run": dict(run.ledger.run), **run.ledger.head()}
            if run.guard:
                carried["guard"] = run.state
            carried = run.sealed(carried, "head", carried["seq"])
            input = dataclasses.replace(input, headers={**(input.headers or {}), HEAD_HEADER: _converter().to_payload(carried)})
        self.next.continue_as_new(input)


def _make_inbound(config: dict):
    class _Inbound(WorkflowInboundInterceptor):
        def init(self, outbound: WorkflowOutboundInterceptor) -> None:
            self._run_ref = _RunRef(config)
            super().init(_Outbound(outbound, self._run_ref))

        async def _flush(self, run: _Run) -> bool:
            """Carry everything still pending. Never raises: bookkeeping never changes the outcome."""
            for _ in range(CLOSE_FLUSHES):
                if run.ledger.pending() == 0:
                    return True
                run.flushing = True
                try:
                    handle = temporalio.workflow.start_activity(
                        FLUSH_ACTIVITY, {"head": run.ledger.head()}, start_to_close_timeout=timedelta(minutes=1),
                        retry_policy=RetryPolicy(maximum_attempts=5))
                except BaseException:  # noqa: BLE001
                    return False
                finally:
                    run.flushing = False
                try:
                    await asyncio.shield(handle)
                except BaseException:  # noqa: BLE001
                    return False
            return run.ledger.pending() == 0

        async def _close(self, run: _Run, outcome: str):
            run.close(outcome)
            await self._flush(run)

        async def execute_workflow(self, input: ExecuteWorkflowInput) -> Any:
            info = temporalio.workflow.info()
            resume = None
            # Accept a handed-over head only from a real Continue-as-New: a client
            # could otherwise start a run mid-chain with no admission.
            if info.continued_run_id and (input.headers or {}).get(HEAD_HEADER) is not None:
                try:
                    resume = _converter().from_payload(input.headers[HEAD_HEADER], dict)
                except Exception:  # noqa: BLE001 — an unreadable hand-over starts a fresh chain
                    resume = None
                if resume is not None:
                    # A sealed head that does not open (tampered, transplanted from
                    # another run, unknown key) fails the workflow TASK, as in TS: it
                    # never silently restarts the chain and resets the guard.
                    resume = open_header(resume, config.get("header_keys") or {},
                                         expect={"runId": info.continued_run_id, "purpose": "head"})
            # A fresh execution's handlers may already have created the chain.
            run = self._run_ref.run if resume is None and self._run_ref.run is not None else _Run(config, resume)
            self._run_ref.run = run
            try:
                result = await super().execute_workflow(input)
            except temporalio.workflow.ContinueAsNewError:
                run.close("continued-as-new")  # normally already closed by continue_as_new
                await self._flush(run)
                raise
            except BaseException as err:
                # Only what closes the workflow is closed here: a cancellation, a
                # Temporal failure, or a type the worker or workflow declared a
                # failure. Anything else fails the workflow TASK: we add no command,
                # so the fixed code still replays (review D1). Eviction is neither.
                if not _evicting() and _closes_workflow(err):
                    await self._close(run, _outcome_of(err))
                raise
            await self._close(run, "completed")
            return result

        async def handle_signal(self, input: HandleSignalInput) -> None:
            run = await self._run_ref.started()
            run.append("proposal", {"source": "signal", "action": input.signal, "dataDigest": _args_digest(input.args)})
            if run.guard:
                run.state = run.guard.signal(run.state, input.signal, _now_ms())
            try:
                return await super().handle_signal(input)
            except temporalio.workflow.ContinueAsNewError:
                run.close("continued-as-new")
                await self._flush(run)
                raise

        async def handle_update_handler(self, input: HandleUpdateInput) -> Any:
            run = await self._run_ref.started()
            try:
                return await super().handle_update_handler(input)
            except temporalio.workflow.ContinueAsNewError:
                run.close("continued-as-new")
                await self._flush(run)
                raise

    return _Inbound


# ---- the activity side: export and sign ---------------------------------------

async def _settle(value):
    return await value if inspect.isawaitable(value) else value


class _Exporter(ActivityInboundInterceptor):
    """Reads the ledger delta a workflow attached to an activity's headers, checks
    it chains internally AND onto what the sink holds, signs the verified head,
    and hands both to the sink. Never fails the activity: the history holds the
    delta. A gap or a fork is written unsigned and reported; a conflict at a
    held seq is the tamper signal (review PY4, P0/P1 E3).

    With header keys configured, a delta must arrive SEALED, for this activity's
    own execution, as a ledger header (P9 SEC-EX2/SH2): a plaintext header came
    from something that does not hold the key."""

    def __init__(self, next, sink, key, on_conflict=None, on_error=None, header_keys=None):
        super().__init__(next)
        self._sink = sink
        self._key = key
        self._on_conflict = on_conflict
        self._on_error = on_error
        self._header_keys = header_keys or {}

    def _fail(self, err: BaseException):
        if self._on_error:
            try:
                self._on_error(err)
                return
            except Exception:  # noqa: BLE001 — a reporter never fails the activity
                pass
        temporalio.activity.logger.error("polyflow ledger export failed: %s", err)

    def _conflict(self, run: dict, seqs: list):
        if self._on_conflict:
            try:
                self._on_conflict(run, seqs)
                return
            except Exception:  # noqa: BLE001
                pass
        temporalio.activity.logger.error("polyflow ledger conflict for %s/%s at seq %s", run["wf"], run["run"], ",".join(map(str, seqs)))

    async def execute_activity(self, input: ExecuteActivityInput) -> Any:
        p = input.headers.get(LEDGER_HEADER)
        if p is not None and self._sink is not None:
            try:
                info = temporalio.activity.info()
                data = temporalio.activity.payload_converter().from_payload(p, dict)
                data = open_header(data, self._header_keys, required=bool(self._header_keys),
                                   expect={"runId": info.workflow_run_id, "purpose": "ledger"})
                events = data.get("events") if isinstance(data, dict) else None
                if not isinstance(events, list) or not events:
                    raise ValueError("ledger header carries no events")
                run = events[0]["run"]
                # The deployment key vouches only for the activity's OWN workflow.
                if run["wf"] != info.workflow_id or run["ns"] != info.workflow_namespace:
                    raise ValueError(f"ledger delta names run {run['ns']}/{run['wf']}, but the activity belongs to "
                                     f"{info.workflow_namespace}/{info.workflow_id}: refused, not signed")
                # A chain STARTS in the execution that admits it: a delta from seq 0
                # must name this activity's own run, or workflow code could write a
                # signed record for a run that never happened (P9 SEC-EX1). Later
                # deltas keep the chain's first run id across Continue-as-New.
                if events[0]["seq"] == 0 and run["run"] != info.workflow_run_id:
                    raise ValueError(f"ledger delta starts a chain for run {run['run']}, but the activity belongs to run "
                                     f"{info.workflow_run_id}: refused, not signed")
                chk = verify_chain(events, {"seq": events[0]["seq"] - 1, "hash": events[0]["prev"]})
                if not chk["ok"]:
                    raise ValueError(f"ledger delta does not chain at seq {chk['seq']}: {chk['reason']}")
                # Continuity with what the sink already holds: a delta that skips
                # ahead is written (so the gap shows) but not signed, and reported.
                head_fn = getattr(self._sink, "head", None)
                checks = callable(head_fn)
                held = await _settle(head_fn(run)) if checks else None
                gap = checks and (events[0]["seq"] > held["seq"] + 1 if held else events[0]["seq"] > 0)
                # The first event past what the sink holds must point at the sink's head.
                nxt = next((e for e in events if e["seq"] == held["seq"] + 1), None) if held and not gap else None
                continues = nxt is None or nxt["prev"] == held["hash"]
                if gap:
                    self._fail(ValueError(f"ledger gap for {run['wf']}/{run['run']}: the sink holds through seq "
                                          f"{held['seq'] if held else -1}, this delta starts at {events[0]['seq']}"))
                elif not continues:
                    self._fail(ValueError(f"ledger fork for {run['wf']}/{run['run']} at seq {held['seq'] + 1}"))
                # Sign the head of the events verified here, never a head the payload claims.
                signed = _sign(run, chk["head"], self._key) if self._key and not gap and continues else None
                r = await _settle(self._sink.write(events, signed))
                if isinstance(r, dict) and r.get("conflicts"):
                    self._conflict(run, r["conflicts"])
            except Exception as err:  # noqa: BLE001 — export never fails the activity
                self._fail(err)
        return await super().execute_activity(input)


class _Interceptor(Interceptor):
    def __init__(self, config, sink, key, on_conflict=None, on_error=None, header_keys=None):
        self._config = config
        self._sink = sink
        self._key = key
        self._on_conflict = on_conflict
        self._on_error = on_error
        self._header_keys = header_keys or {}

    def intercept_activity(self, next):
        return _Exporter(next, self._sink, self._key, self._on_conflict, self._on_error, self._header_keys)

    def workflow_interceptor_class(self, input: WorkflowInterceptorClassInput):
        return _make_inbound(self._config)


@temporalio.activity.defn(name=FLUSH_ACTIVITY)
async def _flush_activity(_head: dict) -> dict:
    return {"flushed": True}


def PolyflowPlugin(*, level: str = "observe", policy: dict | None = None, sink=None, signing_key: dict | None = None,
                   on_conflict=None, on_error=None, header_key: dict | None = None, header_keys: dict | None = None) -> SimplePlugin:
    """The one line a Temporal Python customer adds: ``Worker(..., plugins=[PolyflowPlugin(...)])``.

    ``policy`` is an ADMITTED policy (the JSON `polyflow policy` prints), with its digest.
    ``on_conflict(run, seqs)`` hears the tamper signal (a different event at a seq
    the sink holds); ``on_error(err)`` hears export failures, gaps and forks.
    Both default to the activity logger.
    ``header_key`` ({keyId, key: base64 of 32 bytes}) seals the ledger and
    Continue-as-New headers (plan P2.6; NFR-7), exactly as the TypeScript plugin
    does; ``header_keys`` ({keyId: key}) are older keys still accepted (rotation).
    With any key configured, the exporter refuses a plaintext ledger header.
    """
    if level not in ("observe", "guard"):
        raise ValueError(f"unknown level '{level}' (observe | guard)")
    if level == "guard":
        if not policy or "digest" not in policy or "kinds" not in policy:
            raise ValueError("level 'guard' needs an ADMITTED policy (run `polyflow policy <file>`; it carries kinds and a digest)")
        check_admitted(policy)  # edited after admission, or a route TS would refuse: not loaded
    if signing_key is not None:
        _load_signer(signing_key)  # fail at construction, not with an unsigned ledger later
    if header_key is not None:
        check_header_key(header_key)
    for kid, k in (header_keys or {}).items():
        check_header_key({"keyId": kid, "key": k})
    all_keys = {**(header_keys or {}), **({header_key["keyId"]: header_key["key"]} if header_key else {})}
    config = {"level": level, "policy": policy if level == "guard" else None,
              **({"header_key": dict(header_key)} if header_key else {}), "header_keys": all_keys}

    def runner(existing):
        from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner
        if isinstance(existing, SandboxedWorkflowRunner):
            return SandboxedWorkflowRunner(restrictions=existing.restrictions.with_passthrough_modules("polyflow_temporal"))
        return existing

    return SimplePlugin(
        "polyflow",
        interceptors=[_Interceptor(config, sink, signing_key, on_conflict, on_error, all_keys)],
        activities=lambda acts: [*(acts or []), _flush_activity],
        workflow_runner=runner,
    )
