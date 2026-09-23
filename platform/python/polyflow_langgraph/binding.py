"""The LangGraph binding: every tool call a LangGraph agent makes becomes
proposal -> verdict -> effect -> observation in the Polyflow ledger, decided by
the Polyflow guard.

The seam
--------
``ToolNode(tools, wrap_tool_call=..., awrap_tool_call=...)`` (langgraph-prebuilt
1.x). It is the interceptor LangGraph itself offers at tool execution: it sees
the model's tool call, the agent's state and the runtime (thread, checkpoint,
task), and it may run the tool, or not, and return the ``ToolMessage`` the
model reads. ``create_react_agent(model, tools)`` accepts a ``ToolNode`` in place
of a tool list and uses it as is, so ``govern(tools, ...)`` governs an agent
without a change to its graph. ``langchain.agents.create_agent`` middleware has
the same ``wrap_tool_call(request, handler)`` shape: ``Governor.wrap_tool_call``
fits there too. A callback handler would only observe (it cannot refuse), and
wrapping each ``BaseTool`` would lose the state and the checkpoint.

Durability: a step is decided as a batch, from the checkpoint
------------------------------------------------------------------
LangGraph is not Temporal: there is no deterministic replay of code, and a tool
may run more than once (a node that fails, or a process that dies, re-runs from
the last checkpoint). What the binding relies on is what LangGraph does
persist:

- the model's tool calls are in the checkpoint before any tool runs, and a
  resumed step re-runs from that same checkpoint, whose id (a uuid6: it carries
  its own timestamp) the runtime exposes;
- a ``ToolMessage`` a task returns is written to the checkpointer when the
  task finishes (a pending write), and a finished task is not re-run.

So the decisions for one model turn are a pure function of the checkpointed
state: the carried chain head and guard state, the model's tool calls in order,
and the checkpoint's own time as the decision time (as a Temporal workflow task
has one time). Every task of the step, and every re-run of it, derives the SAME
events. They are written to the sink BEFORE the tool runs (the sink skips what
it already holds), and they ride in the checkpoint on each ``ToolMessage``'s
``response_metadata`` (never sent to a model), with the call's outcome. The
next model turn's batch (or ``close``) folds those outcomes into observations,
in call order, at the times the tools finished. A resumed thread therefore
continues ONE chain, and a re-run records nothing twice and spends no budget
twice. A closed thread that goes on, or a time-travel fork from an older
checkpoint, diverges from what the sink holds: the binding then starts a new
chain whose admission names the head it continues, and reports the branch.
"""

from __future__ import annotations

import copy
import dataclasses
import json
import logging
import threading
import time
import uuid
from collections import OrderedDict

from polyflow_temporal.canonical import digest
from polyflow_temporal.ledger import Ledger, verify_chain
from polyflow_temporal.redact import redact
from polyflow_temporal.rules import Guard, check_admitted, classify, route_target
from polyflow_temporal.sinks import _load_signer, sign_head

log = logging.getLogger("polyflow.langgraph")

META_KEY = "polyflow"
VIA = "langgraph-tool"
MEMO = 256
_UUID_EPOCH = 0x01B21DD213814000  # 1582-10-15 in 100 ns ticks


# ---- pure helpers ----------------------------------------------------------------

def checkpoint_ms(checkpoint_id) -> int | None:
    """The time a LangGraph checkpoint was taken, in ms, read from its uuid6 id.

    Stable for a checkpoint, so every re-run of a step decides at the same time."""
    try:
        u = uuid.UUID(str(checkpoint_id))
    except (TypeError, ValueError):
        return None
    if u.version != 6:
        return None
    ticks = ((u.int >> 80) << 12) | ((u.int >> 64) & 0x0FFF)
    return (ticks - _UUID_EPOCH) // 10_000


def _now_ms() -> int:
    return int(time.time() * 1000)


def _digest(value) -> str:
    try:
        return digest(value)
    except Exception:  # noqa: BLE001 — a digest never fails a tool call
        return "sha256:unhashable"


def govern_effect(policy, guard, state, target: str, args: list, at, proposal: str):
    """Classify and decide one call: the guard path every tool call takes.

    ``args`` is the argument LIST as it travels (a LangGraph tool call is
    ``[tool_call["args"]]``, so a route such as ``"0.tool_name"`` reads a generic
    tool's first argument, as on Temporal). Returns ``(routed, cls, c, d)``:
    the routed target, the classification, the guard's candidate and its decision.
    """
    a_digest = _digest(args)
    routed = route_target(policy, target, args) if policy else target
    cls = classify(policy, routed) if policy else {"kind": target, "class": "unlabelled", "labels": [], "declared": True}
    c = {**cls, "target": target, "argsDigest": a_digest, "at": at, "proposal": proposal}
    d = guard.decide(state, c) if guard else {"outcome": "allow", "rules": []}
    return routed, cls, c, d


def observe_effect(guard, state, kind: str, ok: bool, labels=None, result=None, seq=None):
    """Fold one effect's outcome into the guard state (a new state)."""
    if guard is None:
        return state
    return guard.observe(state, kind, bool(ok), labels=labels, result=result if ok else None, seq=seq)


def _messages(state) -> list:
    if isinstance(state, dict):
        return list(state.get("messages") or [])
    if isinstance(state, list):
        return state
    return list(getattr(state, "messages", None) or [])


def _is_tool_message(m) -> bool:
    return getattr(m, "type", None) == "tool"


def _meta(m):
    md = getattr(m, "response_metadata", None)
    meta = md.get(META_KEY) if isinstance(md, dict) else None
    return meta if isinstance(meta, dict) and meta.get("v") == 1 else None


def _calls_for(messages: list, tool_call: dict) -> list:
    """The model turn a call belongs to: every call of that AIMessage, in order."""
    cid = tool_call.get("id")
    for m in reversed(messages):
        calls = getattr(m, "tool_calls", None)
        if calls and any(c.get("id") == cid for c in calls):
            return [dict(c) for c in calls]
    return [dict(tool_call)]


def _last_batch(messages: list):
    """The latest governed batch carried in the thread's state, and each call's outcome."""
    for m in reversed(messages):
        meta = _meta(m) if _is_tool_message(m) else None
        if meta is None:
            continue
        batch = meta["batch"]
        outcomes = {}
        for n in messages:
            nm = _meta(n) if _is_tool_message(n) else None
            if nm and nm["batch"]["id"] == batch["id"] and nm["batch"]["run"] == batch["run"] and nm.get("obs"):
                outcomes.setdefault(nm["call"], nm["obs"])
        return batch, outcomes
    return None, {}


def ledger_of(state) -> dict:
    """The ledger events carried in a thread's state, per run (``"ns/wf/run"``),
    in chain order: the LangGraph counterpart of ``polyflow export`` rebuilding a
    record from a Temporal history. The latest batch's outcomes are folded only
    by the next batch or by ``close``."""
    runs: dict = {}
    for m in _messages(state):
        meta = _meta(m) if _is_tool_message(m) else None
        if meta is None:
            continue
        for e in meta["batch"]["events"]:
            r = e["run"]
            runs.setdefault(f"{r['ns']}/{r['wf']}/{r['run']}", {})[e["seq"]] = e
    return {k: [v[s] for s in sorted(v)] for k, v in runs.items()}


def _result_of(content):
    """A tool result as the guard reads it: the JSON a tool's dict became, or the text."""
    if isinstance(content, str):
        try:
            return json.loads(content)
        except ValueError:
            return content
    return content


# ---- the governor ----------------------------------------------------------------

class Governor:
    """Records and guards the tool calls of LangGraph agents.

    ``policy`` is an ADMITTED policy (what ``polyflow policy`` prints, with its
    digest), as for ``PolyflowPlugin``. ``sink`` is a ``FileSink``/``MemorySink``
    (or anything with ``write(events, signed)`` and ``head(run)``); it is called
    synchronously. ``signing_key`` ({keyId, privateKeyPem}, ``polyflow keygen``)
    signs each exported head. ``on_conflict(run, seqs)`` hears a divergence from
    what the sink holds (a branch, or tampering); ``on_error(err)`` hears export
    failures. Both default to the ``polyflow.langgraph`` logger.
    """

    def __init__(self, *, level: str = "observe", policy: dict | None = None, sink=None,
                 signing_key: dict | None = None, ns: str = "langgraph", on_conflict=None, on_error=None):
        if level not in ("observe", "guard"):
            raise ValueError(f"unknown level '{level}' (observe | guard)")
        if level == "guard":
            if not policy or "digest" not in policy or "kinds" not in policy:
                raise ValueError("level 'guard' needs an ADMITTED policy (run `polyflow policy <file>`; it carries kinds and a digest)")
            check_admitted(policy)
        if signing_key is not None:
            _load_signer(signing_key)  # fail now, not with an unsigned ledger later
        self.level = level
        self.policy = policy if level == "guard" else None
        self.guard = Guard(self.policy) if self.policy else None
        self.sink = sink
        self.signing_key = signing_key
        self.ns = str(ns or "langgraph")
        self._on_conflict = on_conflict
        self._on_error = on_error
        self._lock = threading.Lock()
        self._batches: OrderedDict = OrderedDict()
        metered = [r for r in (self.policy or {}).get("rules", []) if r["type"] == "budget" and r.get("metric") != "effects"]
        self._metered_all = any(not r.get("kinds") for r in metered)
        self._metered = {k for r in metered for k in (r.get("kinds") or [])}

    # ---- reporting ----------------------------------------------------------------
    def _fail(self, err: BaseException):
        if self._on_error:
            try:
                self._on_error(err)
                return
            except Exception:  # noqa: BLE001 — a reporter never fails a tool call
                pass
        log.error("polyflow ledger export failed: %s", err)

    def _conflict(self, run: dict, seqs: list):
        if self._on_conflict:
            try:
                self._on_conflict(run, seqs)
                return
            except Exception:  # noqa: BLE001
                pass
        log.warning("polyflow ledger for %s/%s diverges from the sink at seq %s: continuing on a new, linked chain",
                    run["wf"], run["run"], ",".join(map(str, seqs)))

    # ---- deciding a batch (pure, given the checkpointed state) ---------------------
    def _fold(self, prev: dict, outcomes: dict, at_missing):
        """Resume the chain after ``prev``: its head, its guard state, and its calls' outcomes."""
        ledger = Ledger(prev["run"], prev["head"])
        state = copy.deepcopy(prev["guard"])
        for call in prev["calls"]:
            if call["outcome"] != "allowed":
                continue
            o = outcomes.get(call["index"])
            if o is None:
                body = {"effect": call["effect"], "ok": False, "error": "no outcome recorded: the tool message is not in the thread's state"}
                ok, at, result = False, at_missing, None
            else:
                ok, at, result = bool(o["ok"]), o["at"], o.get("result")
                body = {"effect": call["effect"], "ok": True, "resultDigest": o["resultDigest"]} if ok else {"effect": call["effect"], "ok": False, "error": o["error"]}
            ledger.append("observation", body, at)
            state = observe_effect(self.guard, state, call["kind"], ok, labels=call["labels"], result=result, seq=call["guardSeq"])
        return ledger, state

    def _admit(self, run: dict, at, thread: str, base: str, link=None) -> Ledger:
        ledger = Ledger(run)
        admission = {"level": self.level, "policy": None}
        if self.policy:
            admission["policy"] = {"name": self.policy["policy"], "version": self.policy["version"], "digest": self.policy["digest"]}
        admission["execution"] = {"engine": "langgraph", "thread": thread, "checkpoint": base}
        if link:
            admission["continues"] = link
        ledger.append("admission", admission, at)
        return ledger

    def _build(self, thread: str, base: str, at, prev, outcomes, calls: list, branch: bool = False) -> dict:
        if prev is not None:
            ledger, state = self._fold(prev, outcomes, at)
        else:
            ledger, state = None, (self.guard.init() if self.guard else None)
        if ledger is None or branch:
            link = None
            run_id = str(base)
            if ledger is not None:
                link = {"run": dict(ledger.run), **ledger.head()}
                if run_id == ledger.run["run"]:
                    run_id = f"{run_id}.branch"
            ledger = self._admit({"ns": self.ns, "wf": thread, "run": run_id}, at, thread, base, link)
        out_calls = []
        for i, call in enumerate(calls):
            tool = str(call.get("name"))
            args = [call.get("args") if call.get("args") is not None else {}]
            proposal = ledger.append("proposal", {"source": "model", "action": tool, "dataDigest": _digest(args)}, at)
            pid = f"p{proposal['seq']}"
            routed, cls, c, d = govern_effect(self.policy, self.guard, state, tool, args, at, pid)
            entry = {"index": i, "id": call.get("id"), "tool": tool}
            if d["outcome"] != "allow":
                # An escalation needs a person; this binding has no inbox: refuse, never allow.
                message = d.get("message") or f"denied by {', '.join(d['rules'])}"
                if d["outcome"] == "escalate":
                    message = f"escalation required ({message}); this binding cannot ask a person yet, so the effect is refused"
                ledger.append("verdict", {"proposal": pid, "outcome": "denied", "rules": d["rules"], "witness": d.get("witness"), "reason": message}, at)
                entry.update({"outcome": "denied", "rules": d["rules"], "message": message, "witness": d.get("witness")})
                out_calls.append(entry)
                continue
            ledger.append("verdict", {"proposal": pid, "outcome": "allowed", "rules": d["rules"]}, at)
            if self.guard:
                state = self.guard.commit(state, c, d)
            eid = f"e{ledger.head()['seq'] + 1}"
            ledger.append("effect", {"id": eid, "proposal": pid, "kind": cls["kind"], "class": cls["class"], "via": VIA,
                                     "activityType": tool, **({"route": routed} if routed != tool else {}),
                                     "argsDigest": c["argsDigest"], "idempotencyKey": f"{thread}/{call.get('id')}"}, at)
            entry.update({"outcome": "allowed", "effect": eid, "kind": cls["kind"], "labels": list(cls["labels"]),
                          "guardSeq": state["seq"] if self.guard else None,
                          "wantsResult": bool(self.guard) and (self._metered_all or cls["kind"] in self._metered)})
            out_calls.append(entry)
        # The batch's own segment: the previous turn's observations (none on a new
        # chain, whose admission comes first), then this turn's decisions.
        return {"id": str(base), "run": dict(ledger.run), "at": at, "events": ledger.events(), "head": ledger.head(),
                "guard": state, "calls": out_calls}

    # ---- export ----------------------------------------------------------------
    def _export(self, events: list, carried=None):
        """Write a chain segment to the sink, backfilling from the carried state if
        the sink is behind, and sign the head verified here. Returns the sink's
        conflicts (a list), or None. Never raises."""
        if self.sink is None or not events:
            return None
        try:
            run = events[0]["run"]
            head_fn = getattr(self.sink, "head", None)
            held = head_fn(run) if callable(head_fn) else None
            behind = callable(head_fn) and (events[0]["seq"] > held["seq"] + 1 if held else events[0]["seq"] > 0)
            if behind and carried is not None:
                key = f"{run['ns']}/{run['wf']}/{run['run']}"
                have = {e["seq"]: e for e in ledger_of(carried).get(key, [])}
                have.update({e["seq"]: e for e in events})
                floor = held["seq"] if held else -1
                events = [have[s] for s in sorted(have) if s > floor]
                behind = not events or events[0]["seq"] != floor + 1
            chk = verify_chain(events, {"seq": events[0]["seq"] - 1, "hash": events[0]["prev"]})
            if not chk["ok"]:
                raise ValueError(f"ledger segment does not chain at seq {chk['seq']}: {chk['reason']}")
            if behind:
                self._fail(ValueError(f"ledger gap for {run['wf']}/{run['run']}: the sink holds through seq "
                                      f"{held['seq'] if held else -1}, this segment starts at {events[0]['seq']}"))
            signed = sign_head(run, chk["head"], self.signing_key) if self.signing_key and not behind else None
            r = self.sink.write(events, signed)
            return (r or {}).get("conflicts") if isinstance(r, dict) else None
        except Exception as err:  # noqa: BLE001 — export never fails a tool call
            self._fail(err)
            return None

    def _batch_for(self, thread: str, base: str, messages: list, calls: list) -> dict:
        key = (thread, str(base), tuple(str(c.get("id")) for c in calls))
        with self._lock:
            batch = self._batches.get(key)
            if batch is not None:
                return batch
            at = checkpoint_ms(base)
            if at is None:
                at = _now_ms()  # not a uuid6 checkpoint id: a re-run would decide at a new time
            prev, outcomes = _last_batch(messages)
            batch = self._build(thread, base, at, prev, outcomes, calls)
            conflicts = self._export(batch["events"], messages)
            if conflicts:
                # The sink holds another continuation of this chain: the thread was
                # closed and went on, or forked from an older checkpoint. Record the
                # branch as a new chain linked to the head it continues.
                self._conflict(batch["run"], conflicts)
                batch = self._build(thread, base, at, prev, outcomes, calls, branch=True)
                again = self._export(batch["events"], messages)
                if again:
                    self._conflict(batch["run"], again)
            self._batches[key] = batch
            while len(self._batches) > MEMO:
                self._batches.popitem(last=False)
            return batch

    # ---- the ToolNode seam -------------------------------------------------------------
    def _enter(self, request):
        info = getattr(getattr(request, "runtime", None), "execution_info", None)
        thread = str(getattr(info, "thread_id", None) or "default")
        base = getattr(info, "checkpoint_id", None) or f"unpersisted-{uuid.uuid4()}"
        messages = _messages(request.state)
        calls = _calls_for(messages, request.tool_call)
        batch = self._batch_for(thread, base, messages, calls)
        cid = request.tool_call.get("id")
        call = next((c for c in batch["calls"] if c["id"] == cid), None)
        return batch, call

    def _meta_for(self, batch: dict, call: dict, obs=None) -> dict:
        return {"v": 1, "batch": batch, "call": call["index"], **({"obs": obs} if obs else {})}

    def _denied(self, request, batch: dict, call: dict):
        from langchain_core.messages import ToolMessage
        content = json.dumps({"error": "PolyflowDenied", "message": call["message"], "rules": call["rules"],
                              "witness": call["witness"]}, ensure_ascii=False)
        return ToolMessage(content=content, name=call["tool"], tool_call_id=request.tool_call.get("id"), status="error",
                           response_metadata={META_KEY: self._meta_for(batch, call)})

    def _carry(self, result, batch: dict, call: dict):
        """Attach the call's outcome to the ToolMessage it produced, so it rides in the checkpoint."""
        from langchain_core.messages import ToolMessage

        def tag(msg):
            ok = getattr(msg, "status", "success") != "error"
            obs = {"ok": ok, "at": _now_ms()}
            if ok:
                obs["resultDigest"] = _digest(msg.content)
                if call.get("wantsResult"):
                    obs["result"] = _result_of(msg.content)
            else:
                obs["error"] = redact(msg.content if isinstance(msg.content, str) else json.dumps(msg.content, default=str), 200)
            md = {**(msg.response_metadata or {}), META_KEY: self._meta_for(batch, call, obs)}
            return msg.model_copy(update={"response_metadata": md})

        if isinstance(result, ToolMessage):
            return tag(result)
        update = getattr(result, "update", None)
        if isinstance(update, dict) and isinstance(update.get("messages"), list):
            msgs = [tag(m) if isinstance(m, ToolMessage) and m.tool_call_id == call["id"] else m for m in update["messages"]]
            return dataclasses.replace(result, update={**update, "messages": msgs})
        # A Command without this call's ToolMessage: the outcome is not carried, and
        # the next batch records it as "no outcome recorded".
        return result

    def wrap_tool_call(self, request, execute):
        """``ToolNode(wrap_tool_call=...)`` / ``AgentMiddleware.wrap_tool_call``."""
        batch, call = self._enter(request)
        if call is None:
            return execute(request)  # not a call of the governed turn (cannot happen via ToolNode)
        if call["outcome"] != "allowed":
            return self._denied(request, batch, call)
        return self._carry(execute(request), batch, call)

    async def awrap_tool_call(self, request, execute):
        """The async form. The sink is still written synchronously."""
        batch, call = self._enter(request)
        if call is None:
            return await execute(request)
        if call["outcome"] != "allowed":
            return self._denied(request, batch, call)
        return self._carry(await execute(request), batch, call)

    # ---- closing and inspecting -------------------------------------------------------
    def snapshot(self, state) -> dict | None:
        """Where the chain stands in a thread's state: its run, head and guard state,
        after folding the latest outcomes (nothing is appended or written)."""
        prev, outcomes = _last_batch(_messages(state))
        if prev is None:
            return None
        ledger, guard_state = self._fold(prev, outcomes, 0)
        return {"run": dict(ledger.run), "head": ledger.head(), "guard": guard_state}

    def close(self, graph, config, outcome: str = "completed") -> dict | None:
        """Fold the last outcomes, append the closure, and export: the thread's record
        is finished. Idempotent for the same final checkpoint. A thread that goes on
        after a close starts a new chain, linked to this one."""
        snap = graph.get_state(config)
        messages = _messages(snap.values)
        prev, outcomes = _last_batch(messages)
        if prev is None:
            return None
        base = (snap.config or {}).get("configurable", {}).get("checkpoint_id")
        at = checkpoint_ms(base)
        if at is None:
            at = _now_ms()
        ledger, state = self._fold(prev, outcomes, at)
        ledger.append("closure", {"outcome": outcome}, at)
        events = ledger.events()
        conflicts = self._export(events, messages)
        if conflicts:
            self._conflict(ledger.run, conflicts)
        return {"run": dict(ledger.run), "head": ledger.head(), "guard": state, "events": events}


def govern(tools, *, level: str = "observe", policy: dict | None = None, sink=None, signing_key: dict | None = None,
           ns: str = "langgraph", on_conflict=None, on_error=None, **tool_node_kwargs):
    """A ``ToolNode`` over ``tools`` whose every call is recorded (and, at
    ``level="guard"``, decided by ``policy``). Pass it where the tool list went:
    ``create_react_agent(model, govern(tools, ...))``. The ``Governor`` is on
    ``.governor``. Extra keyword arguments go to ``ToolNode``."""
    from langgraph.prebuilt import ToolNode

    governor = Governor(level=level, policy=policy, sink=sink, signing_key=signing_key, ns=ns,
                        on_conflict=on_conflict, on_error=on_error)
    if isinstance(tools, ToolNode):
        tools = list(tools.tools_by_name.values())
    node = ToolNode(tools, wrap_tool_call=governor.wrap_tool_call, awrap_tool_call=governor.awrap_tool_call, **tool_node_kwargs)
    node.governor = governor
    return node


def close(governed, graph, config, outcome: str = "completed"):
    """``governed`` is what ``govern`` returned, or a ``Governor``."""
    governor = governed if isinstance(governed, Governor) else governed.governor
    return governor.close(graph, config, outcome)
