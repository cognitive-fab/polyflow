"""The LangGraph binding: every tool call a LangGraph agent makes becomes
proposal -> verdict -> effect -> observation in the Polyflow ledger, decided by
the Polyflow guard.

The seam
--------
``ToolNode(tools, wrap_tool_call=..., awrap_tool_call=...)`` (langgraph-prebuilt
1.1). It is the interceptor LangGraph itself offers at tool execution: it sees
the model's tool call, the agent's state and the runtime (thread, checkpoint),
and it may run the tool, or not, and return the ``ToolMessage`` the model reads.
``create_react_agent(model, tools)`` accepts a ``ToolNode`` in place of a tool
list and uses it as is, so ``govern(tools, ...)`` governs an agent without a
change to its graph. A callback handler would only observe (it cannot refuse),
and wrapping each ``BaseTool`` would lose the thread and the model turn.

Where the authority lives (P10 review)
--------------------------------------
The chain head, the guard state, the decided turns and the effects' outcomes
of a THREAD live in a per-thread record (``store.py``), beside the sink, keyed
by (ns, thread_id). Never in the agent's message list: that list is
unauthenticated, is rewritten by trimming, ``update_state`` and time travel,
and is not the thread (subagents each have their own). The binding reads
nothing back from message metadata; the hint it attaches is for people.

- A model turn (the AIMessage that holds the calls, identified by its id and
  its calls) is decided ONCE, against the thread's current guard state, under
  the record's lock: parallel tasks, subagents and other workers on the thread
  serialise there, so a budget holds across all of them.
- Each decision is bound to its call: (tool_call id, tool name, argument
  digest). A call that matches no decided entry, or a turn whose ids repeat,
  is refused; nothing runs under another call's verdict.
- An effect is observed as soon as its tool returns. A crash re-run (the tool
  raised, or the process died, before the outcome was recorded) runs it again
  under the SAME effect, and the observation says how many attempts it took.
  A replay of a step whose effect was already observed does NOT run the tool
  again: the recorded result is returned.
- A time-travel fork, a trimmed history or a re-entered thread is governed
  against the thread's latest state, never the fork point's. A fork is reported.
"""

from __future__ import annotations

import asyncio
import copy
import dataclasses
import json
import logging
import time
import uuid

from polyflow_temporal.canonical import digest
from polyflow_temporal.ledger import Ledger, verify_chain
from polyflow_temporal.redact import redact
from polyflow_temporal.rules import Guard, check_admitted, classify, route_target
from polyflow_temporal.sinks import _load_signer, sign_head

from .store import MemoryThreadStore, sink_holds_thread, store_for

log = logging.getLogger("polyflow.langgraph")

META_KEY = "polyflow"
VIA = "langgraph-tool"
UNKNOWN_TOOL = "<unknown tool>"
NAME_MAX = 128
TURNS_KEPT = 512
RESULTS_KEPT = 256
_UUID_EPOCH = 0x01B21DD213814000  # 1582-10-15 in 100 ns ticks


# ---- pure helpers ----------------------------------------------------------------

def checkpoint_ms(checkpoint_id) -> int | None:
    """The time a LangGraph checkpoint was taken, in ms, read from its uuid6 id."""
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
    tool's first argument, as on Temporal). Returns ``(routed, cls, c, d)``.
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


def idempotency_key(run: dict, effect_id: str) -> str:
    """Unique per recorded effect, and injective: a digest of the chain and the effect (LG10)."""
    return digest({"run": run, "effect": effect_id})


def _args_of(tool_call: dict) -> list:
    args = tool_call.get("args")
    return [args if args is not None else {}]


def _signature(tool_call: dict) -> list:
    """What a decision is bound to: the call's id, its tool name and its argument digest."""
    return [tool_call.get("id"), _digest(str(tool_call.get("name"))), _digest(_args_of(tool_call))]


def _messages(state, key: str) -> list:
    if isinstance(state, dict):
        return list(state.get(key) or [])
    if isinstance(state, list):
        return state
    return list(getattr(state, key, None) or [])


def _find_turn(messages: list, tool_call: dict):
    """The model turn a call belongs to: the AIMessage holding it, and all its calls in order."""
    cid = tool_call.get("id")
    for m in reversed(messages):
        calls = getattr(m, "tool_calls", None)
        if calls and any(c.get("id") == cid for c in calls):
            return m, [dict(c) for c in calls]
    return None, [dict(tool_call)]


def _result_of(content):
    if isinstance(content, str):
        try:
            return json.loads(content)
        except ValueError:
            return content
    return content


def _bounded(text, n: int = 1000):
    return redact(text, n) if isinstance(text, str) else text


def _clean_witness(w):
    """Model-chosen strings in a witness (a routed tool name) are redacted and bounded (LG9)."""
    if not isinstance(w, dict):
        return w
    w = copy.deepcopy(w)
    cand = w.get("candidate") or {}
    for k in ("kind", "target"):
        if isinstance(cand.get(k), str):
            cand[k] = redact(cand[k], NAME_MAX)
    for r in w.get("rules") or []:
        if isinstance(r.get("fix"), str):
            r["fix"] = redact(r["fix"], 1000)
    return w


def _refusal(request, error: str, message: str, **extra):
    from langchain_core.messages import ToolMessage
    return ToolMessage(content=json.dumps({"error": error, "message": message, **extra}, ensure_ascii=False),
                       name=str(request.tool_call.get("name"))[:NAME_MAX], tool_call_id=request.tool_call.get("id"),
                       status="error")


# ---- the governor ----------------------------------------------------------------

class Governor:
    """Records and guards the tool calls of LangGraph agents.

    ``policy`` is an ADMITTED policy (``polyflow policy``), as for ``PolyflowPlugin``.
    ``sink`` is a ``FileSink``/``MemorySink`` (or anything with ``write(events,
    signed)``); ``store`` is the per-thread record (default: beside the sink;
    required at guard level for any other sink). ``signing_key`` signs each
    exported head. ``tools`` names the tools the node really has (``govern``
    passes it): any other name the model uses is recorded as ``<unknown tool>``
    and, at guard level, refused. ``messages_key`` is the state key the
    ``ToolNode`` reads. ``allow_unthreaded`` lets calls with no thread or
    checkpoint run (a graph with no checkpointer), each on a chain of its own;
    without it they are refused (LG11). ``on_conflict(run, seqs)`` hears forks
    and sink conflicts; ``on_error(err)`` hears export failures.
    """

    def __init__(self, *, level: str = "observe", policy: dict | None = None, sink=None, store=None,
                 signing_key: dict | None = None, ns: str = "langgraph", tools=None, messages_key: str = "messages",
                 allow_unthreaded: bool = False, on_conflict=None, on_error=None):
        if level not in ("observe", "guard"):
            raise ValueError(f"unknown level '{level}' (observe | guard)")
        if level == "guard":
            if not policy or "digest" not in policy or "kinds" not in policy:
                raise ValueError("level 'guard' needs an ADMITTED policy (run `polyflow policy <file>`; it carries kinds and a digest)")
            check_admitted(policy)
        if signing_key is not None:
            _load_signer(signing_key)
        self.level = level
        self.policy = policy if level == "guard" else None
        self.guard = Guard(self.policy) if self.policy else None
        self.sink = sink
        if level == "guard" and sink is not None and not callable(getattr(sink, "runs_of", None)):
            raise ValueError("this sink has no runs_of(ns, wf): the guard cannot tell whether a thread's ledger already exists "
                             "(the fail-closed check); implement the sink protocol (write, head, runs_of)")
        self.store = store or store_for(sink)
        if self.store is None:
            if sink is not None and level == "guard":
                raise ValueError("this sink's durability is unknown: pass store= (a FileThreadStore or your own) "
                                 "so the thread's guard state is kept where the ledger is")
            self.store = MemoryThreadStore()
        self.signing_key = signing_key
        self.ns = str(ns or "langgraph")
        self.known = None if tools is None else {str(t) for t in tools}
        self.messages_key = messages_key or "messages"
        self.allow_unthreaded = allow_unthreaded
        self._on_conflict = on_conflict
        self._on_error = on_error
        metered = [r for r in (self.policy or {}).get("rules", []) if r["type"] == "budget" and r.get("metric") != "effects"]
        self._metered_all = any(not r.get("kinds") for r in metered)
        self._metered = {k for r in metered for k in (r.get("kinds") or [])}

    # ---- reporting ----------------------------------------------------------------
    def _fail(self, err: BaseException):
        if self._on_error:
            try:
                self._on_error(err)
                return
            except Exception:  # noqa: BLE001
                pass
        log.error("polyflow ledger export failed: %s", err)

    def _conflict(self, run: dict, seqs: list, what: str):
        if self._on_conflict:
            try:
                self._on_conflict(run, seqs)
                return
            except Exception:  # noqa: BLE001
                pass
        log.warning("polyflow: %s (thread %s, run %s, seq %s)", what, run["wf"], run["run"], ",".join(map(str, seqs)))

    def _name(self, name) -> str:
        """The tool name as the ledger records it: code-defined names as they are,
        anything else as ``<unknown tool>``; redacted and bounded either way (LG9)."""
        name = str(name)
        if self.known is not None and name not in self.known:
            return UNKNOWN_TOOL
        return redact(name, NAME_MAX)

    # ---- the record ------------------------------------------------------------------
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

    def _new_chain(self, rec, thread: str, base: str, at):
        """A thread's first chain, or the next one after a close (linked to the closure)."""
        runs = rec["runs"] if rec else []
        run_id = str(base)
        while run_id in runs:
            run_id += "+"
        link = rec["closure"] if rec else None
        ledger = self._admit({"ns": self.ns, "wf": thread, "run": run_id}, at, thread, base, link)
        if rec is None:
            rec = {"v": 1, "ns": self.ns, "thread": thread, "runs": [], "guard": self.guard.init() if self.guard else None,
                   "turns": {}, "recent": [], "effects": {}, "results": [], "pending": []}
        rec.update({"run": dict(ledger.run), "head": ledger.head(), "closed": False, "closure": None})
        rec["runs"].append(run_id)
        rec["pending"].extend(ledger.events())
        return rec

    def _export(self, rec: dict):
        """Write the record's pending events to the sink, one run at a time, signing
        each segment's verified head. Only this thread's own events are ever here (LG2)."""
        if self.sink is None:
            rec["pending"] = []
            return
        pending = rec["pending"]
        while pending:
            run = pending[0]["run"]
            n = 0
            while n < len(pending) and pending[n]["run"] == run:
                n += 1
            seg = pending[:n]
            try:
                if run.get("ns") != self.ns or run.get("wf") != rec["thread"]:
                    raise ValueError("a pending segment names another thread: refused")  # cannot happen; never sign it
                chk = verify_chain(seg, {"seq": seg[0]["seq"] - 1, "hash": seg[0]["prev"]})
                if not chk["ok"]:
                    raise ValueError(f"ledger segment does not chain at seq {chk['seq']}: {chk['reason']}")
                signed = sign_head(run, chk["head"], self.signing_key) if self.signing_key else None
                r = self.sink.write(seg, signed)
            except Exception as err:  # noqa: BLE001 — kept pending, retried on the next write
                self._fail(err)
                rec["pending"] = pending
                return
            if isinstance(r, dict) and r.get("conflicts"):
                self._conflict(run, r["conflicts"], "the sink holds different events for this chain (tampering, or a second store)")
            pending = pending[n:]
        rec["pending"] = []

    def _decide(self, thread: str, base: str, turn_key: str, ai_id, calls: list, messages: list):
        """Decide a model turn once, against the thread's current state. Returns the turn."""
        with self.store.transaction(self.ns, thread) as tx:
            rec = tx.record
            if rec is not None and turn_key in rec["turns"]:
                if rec["pending"]:
                    self._export(rec)
                    tx.commit(rec)
                return rec["turns"][turn_key], rec
            at = _now_ms()
            if rec is None and self.guard and sink_holds_thread(self.sink, self.ns, thread):
                # The ledger has a chain for this thread but its record is gone: never start
                # a fresh guard over a thread that already spent (LG3); refuse until restored.
                msg = "this thread's governance record is missing while its ledger exists: refused until an operator restores it"
                return {"calls": [{"index": i, "sig": _signature(c), "outcome": "denied", "rules": ["polyflow:record-missing"],
                                   "message": msg, "witness": None} for i, c in enumerate(calls)], "transient": True}, None
            if rec is None or rec["closed"]:
                rec = self._new_chain(rec, thread, base, at)
            present = {getattr(m, "id", None) for m in messages} - {None}
            parent = next((k for k, aid in reversed(rec["recent"]) if aid in present), None)
            if rec["turns"]:
                self._report_fork(rec, parent)
            ledger = Ledger(rec["run"], rec["head"])
            state = rec["guard"]
            ids = [c.get("id") for c in calls]
            dup = {i for i in ids if not i or ids.count(i) > 1}
            first = rec["head"]["seq"] + 1
            entries = []
            for i, call in enumerate(calls):
                name, real = self._name(call.get("name")), str(call.get("name"))
                args = _args_of(call)
                proposal = ledger.append("proposal", {"source": "model", "action": name, "dataDigest": _digest(args),
                                                      "checkpoint": str(base)}, at)
                pid = f"p{proposal['seq']}"
                entry = {"index": i, "id": call.get("id"), "sig": _signature(call), "name": name}
                if call.get("id") in dup or not call.get("id"):
                    d = {"outcome": "deny", "rules": ["polyflow:duplicate-call-id"],
                         "message": "this turn repeats (or omits) a tool_call id; every call of the turn is refused. Retry with unique ids",
                         "witness": {"rules": [{"id": "polyflow:duplicate-call-id", "type": "binding",
                                                "fix": "give every tool call of a turn its own id"}]}}
                elif self.guard and name == UNKNOWN_TOOL:
                    d = {"outcome": "deny", "rules": ["polyflow:unknown-tool"], "message": "the node has no tool by that name",
                         "witness": {"rules": [{"id": "polyflow:unknown-tool", "type": "binding", "fix": "call one of the node's tools"}]}}
                else:
                    routed, cls, c, d = govern_effect(self.policy, self.guard, state, real, args, at, pid)
                if d["outcome"] != "allow":
                    message = d.get("message") or f"denied by {', '.join(d['rules'])}"
                    if d["outcome"] == "escalate":
                        message = f"escalation required ({message}); this binding cannot ask a person yet, so the effect is refused"
                    message, witness = _bounded(message), _clean_witness(d.get("witness"))
                    ledger.append("verdict", {"proposal": pid, "outcome": "denied", "rules": d["rules"], "witness": witness, "reason": message}, at)
                    entry.update({"outcome": "denied", "rules": d["rules"], "message": message, "witness": witness})
                    entries.append(entry)
                    continue
                ledger.append("verdict", {"proposal": pid, "outcome": "allowed", "rules": d["rules"]}, at)
                if self.guard:
                    state = self.guard.commit(state, c, d)
                eid = f"e{ledger.head()['seq'] + 1}"
                ekey = f"{rec['run']['run']}|{eid}"
                ledger.append("effect", {"id": eid, "proposal": pid, "kind": cls["kind"] if name != UNKNOWN_TOOL else UNKNOWN_TOOL,
                                         "class": cls["class"], "via": VIA, "activityType": name,
                                         **({"route": redact(routed, NAME_MAX)} if routed != real else {}),
                                         **({"nameDigest": _digest(real)} if name == UNKNOWN_TOOL else {}),
                                         "argsDigest": c["argsDigest"], "idempotencyKey": idempotency_key(rec["run"], eid)}, at)
                rec["effects"][ekey] = {"run": dict(rec["run"]), "id": eid, "kind": cls["kind"], "labels": list(cls["labels"]),
                                        "guardSeq": state["seq"] if self.guard else None, "attempts": 0, "observed": False,
                                        "wantsResult": bool(self.guard) and (self._metered_all or cls["kind"] in self._metered)}
                entry.update({"outcome": "allowed", "effect": ekey, "idempotencyKey": idempotency_key(rec["run"], eid)})
                entries.append(entry)
            turn = {"calls": entries, "first": first, "run": dict(rec["run"]), "ai": ai_id, "parent": parent}
            rec["turns"][turn_key] = turn
            rec["recent"].append([turn_key, ai_id])
            self._trim(rec)
            rec["head"], rec["guard"] = ledger.head(), state
            rec["pending"].extend(ledger.events())
            self._export(rec)
            tx.commit(rec)
            return turn, rec

    def _report_fork(self, rec: dict, parent):
        """A time-travel fork: the state holds a decided turn (``parent``) from which a
        LATER turn was decided (its lineage leads back to ``parent``), and that later
        turn is absent. A subagent with its own message list has its own lineage, so
        its newer turns are not a fork of this one (review 4). Governance never
        depends on this report: the turn is decided on the thread's latest state."""
        recent = rec["recent"]
        keys = [k for k, _ in recent]
        start = keys.index(parent) + 1 if parent in keys else 0
        for key in keys[start:]:
            turn = rec["turns"].get(key)
            lineage, seen = turn.get("parent") if turn else None, set()
            while lineage is not None and lineage not in seen:
                if lineage == parent:
                    self._conflict(rec["run"], [turn["first"]],
                                   "a time-travel fork: governed against the thread's latest guard state, not the fork point's")
                    return
                seen.add(lineage)
                lineage = (rec["turns"].get(lineage) or {}).get("parent")

    def _trim(self, rec: dict):
        while len(rec["recent"]) > TURNS_KEPT:
            key, _ = rec["recent"].pop(0)
            turn = rec["turns"].pop(key, None) or {}
            for e in turn.get("calls", []):
                eff = rec["effects"].get(e.get("effect"))
                if eff and eff["observed"]:
                    rec["effects"].pop(e["effect"], None)
                    self._drop_result(rec, e["effect"])

    def _start(self, thread: str, ekey: str):
        with self.store.transaction(self.ns, thread) as tx:
            rec = tx.record
            eff = rec["effects"].get(ekey)
            if eff is None or eff["observed"]:
                return "replay", (self.store.get_blob(self.ns, thread, ekey) if ekey in rec["results"] else None, eff)
            eff["attempts"] += 1
            tx.commit(rec)
            return "run", eff["attempts"]

    def _finish(self, thread: str, ekey: str, ok: bool, content, status, via_command=False):
        with self.store.transaction(self.ns, thread) as tx:
            rec = tx.record
            eff = rec["effects"].get(ekey)
            if eff is None or eff["observed"]:
                return eff
            body = {"effect": eff["id"], "ok": bool(ok)}
            if ok:
                body["resultDigest"] = _digest(None if via_command else content)
            else:
                body["error"] = redact(content if isinstance(content, str) else json.dumps(content, default=str), 200)
            if eff["attempts"] > 1:
                body["attempts"] = eff["attempts"]
            if eff["run"] == rec["run"] and not rec["closed"]:
                ledger = Ledger(rec["run"], rec["head"])
                ledger.append("observation", body, _now_ms())
                rec["head"] = ledger.head()
                rec["pending"].extend(ledger.events())
                result = _result_of(content) if ok and eff["wantsResult"] and not via_command else None
                rec["guard"] = observe_effect(self.guard, rec["guard"], eff["kind"], ok, labels=eff["labels"], result=result, seq=eff["guardSeq"])
            eff["observed"] = True
            if not via_command:
                # The result is a blob beside the record (review 6): the record stays small.
                self.store.put_blob(self.ns, thread, ekey, {"content": content, "status": status})
                rec["results"].append(ekey)
                while len(rec["results"]) > RESULTS_KEPT:
                    self._drop_result(rec, rec["results"][0])
            self._export(rec)
            tx.commit(rec)
            return eff

    def _drop_result(self, rec: dict, ekey: str):
        if ekey in rec["results"]:
            rec["results"].remove(ekey)
        self.store.delete_blob(self.ns, rec["thread"], ekey)

    # ---- the ToolNode seam -------------------------------------------------------------
    def _enter(self, request):
        """Decide (or find) the call's turn and bind the call to its entry. Returns
        ("return", message) or ("run", thread, entry)."""
        info = getattr(getattr(request, "runtime", None), "execution_info", None)
        thread = getattr(info, "thread_id", None)
        base = getattr(info, "checkpoint_id", None)
        if not thread or not base:
            if not self.allow_unthreaded:
                return "return", _refusal(request, "PolyflowRefused",
                                          "no thread or checkpoint to govern this call against (compile the graph with a checkpointer, "
                                          "and use langgraph>=1.2); refused")
            thread, base = str(thread or f"unthreaded-{uuid.uuid4()}"), str(base or uuid.uuid4())
        thread = str(thread)
        messages = _messages(request.state, self.messages_key)
        ai, calls = _find_turn(messages, request.tool_call)
        if ai is None and self.guard:
            return "return", _refusal(request, "PolyflowRefused",
                                      f"the model turn holding this call is not in the state's '{self.messages_key}': refused")
        ai_id = getattr(ai, "id", None) if ai is not None else None
        # A turn is its AIMessage id plus its calls. Without an id (a reducer that assigns
        # none), the checkpoint stands in, so a later genuine turn with the same calls is
        # never mistaken for a replay (review 3).
        turn_key = digest({"ai": ai_id, "calls": [_signature(c) for c in calls], **({} if ai_id else {"checkpoint": str(base)})})
        turn, _ = self._decide(thread, str(base), turn_key, ai_id, calls, messages)
        sig = _signature(request.tool_call)
        matches = [e for e in turn["calls"] if e["sig"] == sig]
        if len(matches) != 1:
            return "return", _refusal(request, "PolyflowRefused", "this call does not match exactly one decided call of its turn: refused")
        entry = matches[0]
        if entry["outcome"] != "allowed":
            return "return", _refusal(request, "PolyflowDenied", entry["message"], rules=entry["rules"], witness=entry["witness"])
        kind, detail = self._start(thread, entry["effect"])
        if kind == "replay":
            return "return", self._replayed(request, entry, *detail)
        return "run", thread, entry

    def _replayed(self, request, entry, result, eff):
        from langchain_core.messages import ToolMessage
        md = {META_KEY: {"effect": entry["effect"], "replayed": True}}
        if result is None:
            return ToolMessage(content=json.dumps({"error": "PolyflowReplay", "message": "this call already ran; its result is not "
                                                   "retained, and it is not run again"}), name=entry["name"],
                               tool_call_id=request.tool_call.get("id"), status="error", response_metadata=md)
        return ToolMessage(content=result["content"], name=entry["name"], tool_call_id=request.tool_call.get("id"),
                           status=result.get("status") or "success", response_metadata=md)

    def _after(self, thread: str, entry: dict, result):
        from langchain_core.messages import ToolMessage
        hint = {META_KEY: {"effect": entry["effect"], "idempotencyKey": entry["idempotencyKey"]}}

        def tag(msg):
            return msg.model_copy(update={"response_metadata": {**(msg.response_metadata or {}), **hint}})

        if isinstance(result, ToolMessage):
            self._finish(thread, entry["effect"], getattr(result, "status", "success") != "error", result.content, result.status)
            return tag(result)
        update = getattr(result, "update", None)
        msgs = update.get("messages") if isinstance(update, dict) else None
        mine = [m for m in (msgs or []) if isinstance(m, ToolMessage) and m.tool_call_id == entry["id"]]
        if mine:
            self._finish(thread, entry["effect"], mine[0].status != "error", mine[0].content, mine[0].status)
            new = [tag(m) if m is mine[0] else m for m in msgs]
            return dataclasses.replace(result, update={**update, "messages": new})
        self._finish(thread, entry["effect"], True, None, None, via_command=True)
        return result

    def wrap_tool_call(self, request, execute):
        """``ToolNode(wrap_tool_call=...)``."""
        step = self._enter(request)
        if step[0] == "return":
            return step[1]
        _, thread, entry = step
        return self._after(thread, entry, execute(request))  # an exception leaves the effect open: a re-run retries it

    async def awrap_tool_call(self, request, execute):
        """The async form: the record and the sink are written off the event loop (AS1)."""
        step = await asyncio.to_thread(self._enter, request)
        if step[0] == "return":
            return step[1]
        _, thread, entry = step
        result = await execute(request)
        return await asyncio.to_thread(self._after, thread, entry, result)

    # ---- closing and inspecting -------------------------------------------------------
    def snapshot(self, thread: str) -> dict | None:
        """The thread's current chain, head and guard state (from its record)."""
        rec = self.store.peek(self.ns, str(thread))
        if rec is None:
            return None
        return {"run": rec["run"], "head": rec["head"], "guard": rec["guard"], "closed": rec["closed"], "runs": list(rec["runs"])}

    def close(self, config, legacy=None, *, outcome: str = "completed") -> dict | None:
        """Append the closure to the thread's chain and export it. An effect still open
        is observed as "no outcome recorded before close", and folded into the guard
        state like any failed outcome. Idempotent. A thread that goes on afterwards
        starts a new chain whose admission ``continues`` the closure.
        ``config`` is the thread's LangGraph config. (The former ``(graph, config)``
        form is still accepted; the graph was never used.)"""
        if legacy is not None:
            config = legacy
        thread = str(((config or {}).get("configurable") or {}).get("thread_id"))
        with self.store.transaction(self.ns, thread) as tx:
            rec = tx.record
            if rec is None:
                return None
            if not rec["closed"]:
                ledger = Ledger(rec["run"], rec["head"])
                at = _now_ms()
                for eff in rec["effects"].values():
                    if not eff["observed"] and eff["run"] == rec["run"]:
                        ledger.append("observation", {"effect": eff["id"], "ok": False, "error": "no outcome recorded before close"}, at)
                        rec["guard"] = observe_effect(self.guard, rec["guard"], eff["kind"], False, labels=eff["labels"], seq=eff["guardSeq"])
                        eff["observed"] = True
                ledger.append("closure", {"outcome": outcome}, at)
                rec["head"] = ledger.head()
                rec["closed"] = True
                rec["closure"] = {"run": dict(rec["run"]), **ledger.head()}
                rec["pending"].extend(ledger.events())
            self._export(rec)
            tx.commit(rec)
            return {"run": dict(rec["run"]), "head": rec["head"], "guard": rec["guard"]}


def govern(tools, *, level: str = "observe", policy: dict | None = None, sink=None, store=None,
           signing_key: dict | None = None, ns: str = "langgraph", allow_unthreaded: bool = False,
           on_conflict=None, on_error=None, **tool_node_kwargs):
    """A ``ToolNode`` over ``tools`` whose every call is recorded (and, at
    ``level="guard"``, decided by ``policy``). Pass it where the tool list went:
    ``create_react_agent(model, govern(tools, ...))``. The ``Governor`` is on
    ``.governor``. Extra keyword arguments go to ``ToolNode`` (``messages_key``
    is also given to the governor)."""
    from langgraph.prebuilt import ToolNode

    if isinstance(tools, ToolNode):
        tools = list(tools.tools_by_name.values())
    names = list(ToolNode(tools).tools_by_name)  # the names the node really has (LG9)
    governor = Governor(level=level, policy=policy, sink=sink, store=store, signing_key=signing_key, ns=ns,
                        tools=names, messages_key=tool_node_kwargs.get("messages_key", "messages"),
                        allow_unthreaded=allow_unthreaded, on_conflict=on_conflict, on_error=on_error)
    node = ToolNode(tools, wrap_tool_call=governor.wrap_tool_call, awrap_tool_call=governor.awrap_tool_call, **tool_node_kwargs)
    node.governor = governor
    return node


def close(governed, config, legacy=None, *, outcome: str = "completed"):
    """``governed`` is what ``govern`` returned, or a ``Governor``; ``config`` the thread's config."""
    governor = governed if isinstance(governed, Governor) else governed.governor
    return governor.close(config, legacy, outcome=outcome)


# ---- checking a thread's record (VF1) ---------------------------------------------

def _thread_runs(sink, ns: str, thread: str) -> dict:
    runs_of = getattr(sink, "runs_of", None)
    if not callable(runs_of):
        raise TypeError("verify_thread needs a sink with runs_of(ns, wf) (FileSink and MemorySink have it)")
    return runs_of(ns, thread)


def verify_thread(sink, thread: str, ns: str = "langgraph") -> dict:
    """What ``polyflow verify`` does not check for this binding (VF1): every chain of
    a thread, as one record. Each chain verifies; exactly one chain starts the
    thread; every other one ``continues`` a CLOSURE of another chain of the thread,
    and no closure is continued twice; at most one chain is open, and it is the
    last; every effect follows its proposal's ``allowed`` verdict; every
    observation names an effect of its chain, once."""
    problems = []
    runs = _thread_runs(sink, ns, str(thread))
    if not runs:
        return {"ok": False, "problems": ["no chain for this thread"], "chains": 0}
    roots, continued, open_runs = [], {}, []
    for run_id, events in runs.items():
        chk = verify_chain(events)
        if not chk["ok"]:
            problems.append(f"{run_id}: chain breaks at seq {chk['seq']}: {chk['reason']}")
            continue
        first = events[0]
        if first["kind"] != "admission" or first["body"].get("execution", {}).get("thread") != str(thread):
            problems.append(f"{run_id}: does not start with this thread's admission")
        link = first["body"].get("continues") if first["kind"] == "admission" else None
        if not link:
            roots.append(run_id)
        else:
            target = runs.get((link.get("run") or {}).get("run"))
            at = next((e for e in target or [] if e["seq"] == link.get("seq")), None)
            if at is None or at["hash"] != link.get("hash") or at["kind"] != "closure":
                problems.append(f"{run_id}: its continues link does not resolve to a closure of this thread")
            key = (json.dumps(link.get("run"), sort_keys=True), link.get("seq"))
            if key in continued:
                problems.append(f"{run_id} and {continued[key]} both continue the same closure")
            continued[key] = run_id
        if not any(e["kind"] == "closure" for e in events):
            open_runs.append(run_id)
        verdicts, effects, observed = {}, {}, set()
        for e in events:
            b = e["body"]
            if e["kind"] == "verdict":
                verdicts[b.get("proposal")] = b.get("outcome")
            elif e["kind"] == "effect":
                if verdicts.get(b.get("proposal")) != "allowed":
                    problems.append(f"{run_id}: effect {b.get('id')} does not follow an allowed verdict")
                effects[b.get("id")] = e
            elif e["kind"] == "observation":
                if b.get("effect") not in effects:
                    problems.append(f"{run_id}: observation of unknown effect {b.get('effect')}")
                if b.get("effect") in observed:
                    problems.append(f"{run_id}: effect {b.get('effect')} observed twice")
                observed.add(b.get("effect"))
    if len(roots) != 1:
        problems.append(f"the thread has {len(roots)} unlinked chains; it must have exactly one")
    if len(open_runs) > 1:
        problems.append(f"the thread has {len(open_runs)} open chains: {sorted(open_runs)}")
    return {"ok": not problems, "problems": problems, "chains": len(runs), "open": open_runs}
