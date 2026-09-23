"""P10: the second engine binding. An UNMODIFIED prebuilt LangGraph ReAct agent,
driven by a scripted chat model (no network), governed at the ToolNode seam by
the same ledger and the same guard as the Temporal plugin."""

import json
import subprocess
import sys
import uuid
import warnings
from pathlib import Path

import pytest

pytest.importorskip("langgraph.prebuilt")

from langchain_core.language_models import BaseChatModel  # noqa: E402
from langchain_core.messages import AIMessage, ToolMessage  # noqa: E402
from langchain_core.outputs import ChatGeneration, ChatResult  # noqa: E402
from langchain_core.tools import tool  # noqa: E402
from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from langgraph.prebuilt import create_react_agent  # noqa: E402

from polyflow_langgraph import Governor, checkpoint_ms, govern, govern_effect, ledger_of, observe_effect  # noqa: E402
from polyflow_temporal.canonical import digest  # noqa: E402
from polyflow_temporal.ledger import verify_chain  # noqa: E402
from polyflow_temporal.rules import Guard, route_target  # noqa: E402
from polyflow_temporal.sinks import FileSink, MemorySink  # noqa: E402

PLATFORM = Path(__file__).resolve().parents[2]
CLI = PLATFORM / "packages" / "cli" / "bin" / "polyflow.mjs"
CONF = PLATFORM / "conformance"


def admit(raw: dict) -> dict:
    src = PLATFORM / "python" / f".tmp-policy-{uuid.uuid4().hex}.json"
    src.write_text(json.dumps(raw))
    try:
        out = subprocess.run(["node", str(CLI), "policy", str(src)], capture_output=True, text=True, check=True)
    finally:
        src.unlink()
    return json.loads(out.stdout)


@pytest.fixture(scope="module")
def refunds_policy():
    return admit({
        "policy": "refunds", "version": 1,
        "effects": {
            "read_ticket": {"kind": "read", "class": "none", "labels": ["reads-private"]},
            "issue_refund": {"kind": "refund", "class": "irreversible"},
        },
        "rules": [
            {"id": "read-before-refund", "type": "requires-prior", "guards": "refund", "prior": "read"},
            {"id": "one-refund", "type": "at-most", "guards": "refund", "n": 1},
        ],
    })


# ---- the agent: tools, a scripted model, the prebuilt ReAct graph ------------------

CALLS: list = []   # what actually ran (LangGraph may run a tool more than once)
FLAKY: dict = {}   # tool-call id -> failures left before it succeeds


@tool
def read_ticket(ticket: str) -> dict:
    """Read a support ticket."""
    CALLS.append(("read_ticket", ticket))
    if FLAKY.get(ticket, 0) > 0:
        FLAKY[ticket] -= 1
        raise RuntimeError(f"worker died while reading {ticket}")
    return {"ticket": ticket, "customer": "c-1", "amount": 25}


@tool
def issue_refund(ticket: str, amount: int) -> str:
    """Refund a ticket's customer."""
    CALLS.append(("issue_refund", ticket))
    if FLAKY.get(f"refund:{ticket}", 0) > 0:
        FLAKY[f"refund:{ticket}"] -= 1
        raise RuntimeError("worker died mid-refund")
    return f"refunded {amount} on {ticket}"


def call(name, cid, **args):
    return {"name": name, "args": args, "id": cid, "type": "tool_call"}


class ScriptedModel(BaseChatModel):
    """Answers from the conversation so far (not from a cursor), so a resumed
    thread in a fresh process gets the same next turn."""

    script: list

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        turns = sum(1 for m in messages if isinstance(m, AIMessage))
        if turns < len(self.script) and self.script[turns]:  # [] is a final answer
            msg = AIMessage(content="", tool_calls=self.script[turns])
        else:
            last = [m.content for m in messages if isinstance(m, ToolMessage)]
            msg = AIMessage(content="final: " + (last[-1] if last else ""))
        return ChatResult(generations=[ChatGeneration(message=msg)])


REFUND_SCRIPT = [
    [call("issue_refund", "c1", ticket="T1", amount=25)],   # before any read: denied
    [call("read_ticket", "c2", ticket="T1")],
    [call("issue_refund", "c3", ticket="T1", amount=25)],   # allowed
    [call("issue_refund", "c4", ticket="T1", amount=25)],   # a second refund: denied
]


def agent(tools_node, script, saver=None, **kw):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return create_react_agent(ScriptedModel(script=script), tools_node, checkpointer=saver or InMemorySaver(), **kw)


def cfg(thread):
    return {"configurable": {"thread_id": thread}}


def chain(sink, thread):
    runs = [(k, r) for k, r in sink.runs.items() if k[1] == thread]
    assert len(runs) == 1, f"one chain for the thread, got {[k for k, _ in runs]}"
    r = runs[0][1]
    return [r["events"][s] for s in sorted(r["events"])], r["heads"]


@pytest.fixture(autouse=True)
def _reset():
    CALLS.clear()
    FLAKY.clear()


# ---- (a) (b): the record, and a denial the model reads -----------------------------

def test_every_tool_call_is_recorded_and_the_guard_decides(refunds_policy):
    sink = MemorySink()
    tools = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink)
    graph = agent(tools, REFUND_SCRIPT)
    out = graph.invoke({"messages": [("user", "refund T1")]}, cfg("a"))
    tools.governor.close(graph, cfg("a"))

    events, _ = chain(sink, "a")
    assert verify_chain(events)["ok"]
    assert [e["kind"] for e in events] == [
        "admission",
        "proposal", "verdict",                                  # c1: refund before read, denied
        "proposal", "verdict", "effect", "observation",         # c2: read
        "proposal", "verdict", "effect", "observation",         # c3: refund
        "proposal", "verdict",                                  # c4: second refund, denied
        "closure",
    ]
    assert events[0]["body"]["policy"]["digest"] == refunds_policy["digest"]
    assert events[0]["body"]["execution"]["engine"] == "langgraph"
    verdicts = [(e["body"]["outcome"], e["body"]["rules"]) for e in events if e["kind"] == "verdict"]
    assert verdicts == [("denied", ["read-before-refund"]), ("allowed", []), ("allowed", ["read-before-refund", "one-refund"]),
                        ("denied", ["read-before-refund", "one-refund"])]   # a read licenses ONE refund (consume)
    effects = [e["body"] for e in events if e["kind"] == "effect"]
    assert [(b["activityType"], b["kind"], b["via"]) for b in effects] == [("read_ticket", "read", "langgraph-tool"), ("issue_refund", "refund", "langgraph-tool")]
    assert effects[1]["idempotencyKey"] == "a/c3"
    assert all(e["body"]["ok"] for e in events if e["kind"] == "observation")
    # Only the allowed calls ran.
    assert CALLS == [("read_ticket", "T1"), ("issue_refund", "T1")]

    # (b) the model saw the witness as the tool result, and ended its turn on it.
    denied = [m for m in out["messages"] if isinstance(m, ToolMessage) and m.status == "error"]
    assert [m.tool_call_id for m in denied] == ["c1", "c4"]
    seen = json.loads(denied[-1].content)
    assert seen["error"] == "PolyflowDenied" and seen["rules"] == ["read-before-refund", "one-refund"]
    fixes = {r["id"]: r["fix"] for r in seen["witness"]["rules"]}
    assert fixes["one-refund"].startswith("'refund' may happen at most 1 time(s)")
    assert "refund" not in seen["witness"]["allowedNow"]
    assert out["messages"][-1].content.startswith("final: ") and "PolyflowDenied" in out["messages"][-1].content
    # The witness in the record is the one the model read.
    denied_verdict = [e for e in events if e["kind"] == "verdict" and e["body"]["outcome"] == "denied"][-1]
    assert digest(denied_verdict["body"]["witness"]) == digest(seen["witness"])


async def test_the_async_path_records_and_decides_the_same(refunds_policy):
    sink = MemorySink()
    tools = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink)
    graph = agent(tools, REFUND_SCRIPT)
    out = await graph.ainvoke({"messages": [("user", "refund T1")]}, cfg("async"))
    tools.governor.close(graph, cfg("async"))
    events, _ = chain(sink, "async")
    assert verify_chain(events)["ok"] and events[-1]["kind"] == "closure"
    assert [e["body"]["outcome"] for e in events if e["kind"] == "verdict"] == ["denied", "allowed", "allowed", "denied"]
    assert json.loads(out["messages"][-2].content)["error"] == "PolyflowDenied"


def test_observe_records_without_a_policy():
    sink = MemorySink()
    tools = govern([read_ticket, issue_refund], sink=sink)
    graph = agent(tools, REFUND_SCRIPT)
    graph.invoke({"messages": [("user", "refund T1")]}, cfg("g0"))
    tools.governor.close(graph, cfg("g0"))
    events, _ = chain(sink, "g0")
    assert verify_chain(events)["ok"]
    assert [e["body"]["activityType"] for e in events if e["kind"] == "effect"] == ["issue_refund", "read_ticket", "issue_refund", "issue_refund"]
    assert events[-1]["kind"] == "closure"


def test_a_routed_generic_tool_is_classified_by_the_tool_it_carries():
    policy = admit({
        "policy": "routed", "version": 1,
        "effects": {"call_tool:read_ticket": {"kind": "read", "class": "none"},
                    "call_tool:issue_refund": {"kind": "refund", "class": "irreversible"}},
        "routes": {"call_tool": "0.tool_name"},
        "unlabelled": "report",
        "rules": [{"id": "one-refund", "type": "at-most", "guards": "refund", "n": 1}],
    })

    @tool
    def call_tool(tool_name: str, arguments: dict) -> str:
        """Call a tool on a remote server by name."""
        return f"ok:{tool_name}"

    sink = MemorySink()
    tools = govern([call_tool], level="guard", policy=policy, sink=sink)
    script = [[call("call_tool", "r1", tool_name="read_ticket", arguments={})],
              [call("call_tool", "r2", tool_name="issue_refund", arguments={}), call("call_tool", "r3", tool_name="issue_refund", arguments={}),
               call("call_tool", "r4", tool_name="ISSUE_REFUND", arguments={})]]
    graph = agent(tools, script)
    graph.invoke({"messages": [("user", "go")]}, cfg("routed"))
    tools.governor.close(graph, cfg("routed"))
    events, _ = chain(sink, "routed")
    assert [e["body"].get("route") for e in events if e["kind"] == "effect"] == ["call_tool:read_ticket", "call_tool:issue_refund"]
    verdicts = [(e["body"]["outcome"], e["body"]["rules"]) for e in events if e["kind"] == "verdict"]
    # One refund in a parallel turn; the case variant is routed but undeclared: denied (SEC-UL1).
    assert verdicts == [("allowed", []), ("allowed", ["one-refund"]), ("denied", ["one-refund"]), ("denied", ["unlabelled"])]


# ---- (c): resume from a checkpoint continues ONE chain -----------------------------

def test_a_thread_resumed_in_a_fresh_process_continues_one_chain(refunds_policy):
    saver, sink = InMemorySaver(), MemorySink()
    # The first process stops before every tool step (a human-in-the-loop pause) and goes away.
    first = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink)
    agent(first, REFUND_SCRIPT[1:], saver, interrupt_before=["tools"]).invoke({"messages": [("user", "refund T1")]}, cfg("c"))
    agent(first, REFUND_SCRIPT[1:], saver, interrupt_before=["tools"]).invoke(None, cfg("c"))
    assert CALLS == [("read_ticket", "T1")]
    # A fresh process: a new Governor (no memory of the first), the same checkpointer.
    second = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink)
    graph = agent(second, REFUND_SCRIPT[1:], saver)
    out = graph.invoke(None, cfg("c"))
    second.governor.close(graph, cfg("c"))

    events, _ = chain(sink, "c")
    assert verify_chain(events)["ok"]
    assert sum(e["kind"] == "admission" for e in events) == 1
    assert [e["body"]["activityType"] for e in events if e["kind"] == "effect"] == ["read_ticket", "issue_refund"]
    assert [e["body"]["outcome"] for e in events if e["kind"] == "verdict"] == ["allowed", "allowed", "denied"]
    # The chain carried in the checkpoint is the chain in the sink.
    carried = next(iter(ledger_of(out).values()))
    assert [e["hash"] for e in carried] == [e["hash"] for e in events[:len(carried)]]


def test_a_step_that_dies_mid_tool_is_re_run_but_recorded_once_and_charged_once(refunds_policy):
    saver, sink = InMemorySaver(), MemorySink()
    script = [[call("read_ticket", "c1", ticket="T1"), call("read_ticket", "c2", ticket="T2")],   # parallel; T2's worker dies once
              [call("issue_refund", "c3", ticket="T1", amount=25)],                              # dies once, mid-refund
              [call("issue_refund", "c4", ticket="T1", amount=25)]]
    FLAKY.update({"T2": 1, "refund:T1": 1})
    conflicts = []
    tools = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink, handle_tool_errors=False,
                   on_conflict=lambda run, seqs: conflicts.append(seqs))
    graph = agent(tools, script, saver)
    with pytest.raises(RuntimeError, match="T2"):
        graph.invoke({"messages": [("user", "refund T1")]}, cfg("crash"))
    # Resume in a fresh process: T2 is re-run (at least once, as LangGraph promises).
    tools2 = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink, handle_tool_errors=False,
                    on_conflict=lambda run, seqs: conflicts.append(seqs))
    graph2 = agent(tools2, script, saver)
    with pytest.raises(RuntimeError, match="mid-refund"):
        graph2.invoke(None, cfg("crash"))
    tools3 = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink, handle_tool_errors=False,
                    on_conflict=lambda run, seqs: conflicts.append(seqs))
    graph3 = agent(tools3, script, saver)
    out = graph3.invoke(None, cfg("crash"))
    tools3.governor.close(graph3, cfg("crash"))

    assert CALLS.count(("read_ticket", "T2")) == 2 and CALLS.count(("issue_refund", "T1")) == 2
    assert conflicts == []  # every re-run derived the events the sink already held
    events, _ = chain(sink, "crash")
    assert verify_chain(events)["ok"]
    effects = [e["body"] for e in events if e["kind"] == "effect"]
    # Each proposed call is ONE effect, however often it ran; the re-run refund is the
    # same effect (same idempotency key), not a second refund the budget would refuse.
    assert [(b["activityType"], b["idempotencyKey"]) for b in effects] == [("read_ticket", "crash/c1"), ("read_ticket", "crash/c2"), ("issue_refund", "crash/c3")]
    assert [e["body"]["outcome"] for e in events if e["kind"] == "verdict"] == ["allowed", "allowed", "allowed", "denied"]
    snap = tools3.governor.snapshot(out)
    assert snap["guard"]["n"] == {"read": 2, "refund": 1}
    assert snap["guard"]["ok"] == {"read": 2, "refund": 1}


def test_a_closed_thread_that_goes_on_starts_a_linked_chain(refunds_policy):
    saver, sink = InMemorySaver(), MemorySink()
    branches = []
    tools = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink,
                   on_conflict=lambda run, seqs: branches.append((run["run"], seqs)))
    graph = agent(tools, REFUND_SCRIPT[1:3], saver)
    graph.invoke({"messages": [("user", "refund T1")]}, cfg("more"))
    closed = tools.governor.close(graph, cfg("more"))
    assert tools.governor.close(graph, cfg("more"))["head"] == closed["head"]  # idempotent
    # The user comes back to the same thread; the model tries a second refund.
    more = agent(tools, REFUND_SCRIPT[1:3] + [[], [call("issue_refund", "c9", ticket="T1", amount=25)]], saver)
    more.invoke({"messages": [("user", "and again")]}, cfg("more"))
    assert len(branches) == 1
    old = [r for k, r in sink.runs.items() if k[2] == closed["run"]["run"]][0]
    new = [r for k, r in sink.runs.items() if k[1] == "more" and k[2] != closed["run"]["run"]][0]
    new_events = [new["events"][s] for s in sorted(new["events"])]
    assert verify_chain(new_events)["ok"]
    link = new_events[0]["body"]["continues"]
    assert link["run"] == closed["run"] and old["events"][link["seq"]]["hash"] == link["hash"]
    # The guard state belongs to the thread: the refund budget is still spent.
    assert [e["body"]["outcome"] for e in new_events if e["kind"] == "verdict"] == ["denied"]


# ---- (d): the TypeScript verifier accepts a LangGraph ledger ---------------------

def test_a_langgraph_ledger_verifies_under_the_typescript_cli(refunds_policy, tmp_path):
    key_dir = tmp_path / "keys"
    subprocess.run(["node", str(CLI), "keygen", "--id", "lg-worker", "--out", str(key_dir)], check=True, capture_output=True)
    key = json.loads((key_dir / "lg-worker.key.json").read_text())
    saver, sink = InMemorySaver(), FileSink(tmp_path / "ledger")
    first = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink, signing_key=key)
    agent(first, REFUND_SCRIPT, saver, interrupt_before=["tools"]).invoke({"messages": [("user", "refund T1")]}, cfg("ts"))
    # ...resumed by another process, with its own FileSink over the same directory.
    second = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=FileSink(tmp_path / "ledger"), signing_key=key)
    graph = agent(second, REFUND_SCRIPT, saver)
    graph.invoke(None, cfg("ts"))
    second.governor.close(graph, cfg("ts"))

    files = [p for p in (tmp_path / "ledger").rglob("*.jsonl") if not p.name.endswith(".heads.jsonl")]
    assert len(files) == 1
    out = subprocess.run(["node", str(CLI), "verify", str(files[0]), "--trust", str(key_dir / "trust.json")], capture_output=True, text=True)
    assert out.returncode == 0, out.stdout + out.stderr
    assert "consistent, closed and signed" in out.stdout


# ---- (e): the conformance guard vectors, through the binding's guard path ----------

def _replay(case, check_classification):
    policy = case["policy"]
    guard = Guard(policy)
    s = guard.init()
    for i, step in enumerate(case["steps"]):
        op = step["op"]
        where = f"step {i} ({op['op']} {op.get('activity', op.get('name', op.get('id')))})"
        if op["op"] == "decide-commit":
            routed, cls, c, d = govern_effect(policy, guard, s, op["activity"], op["args"], op["at"], op["proposal"])
            assert c["argsDigest"] == digest(op["args"]), where
            if check_classification:
                assert cls == step["classification"], where
            assert {"outcome": d["outcome"], "rules": d["rules"], "approval": d.get("approval")} == step["decision"], where
            assert (digest(d["witness"]) if d.get("witness") else None) == step["witnessDigest"], f"{where}: witness"
            if d["outcome"] == "allow":
                s = guard.commit(s, c, d)
        elif op["op"] == "observe":
            _, cls, _, _ = govern_effect(policy, None, None, op["activity"], [], 0, "p")
            s = observe_effect(guard, s, cls["kind"], op["ok"], labels=cls["labels"], result=op.get("result"))
        elif op["op"] == "grant":
            _, cls, _, _ = govern_effect(policy, None, None, op["activity"], [], 0, "p")
            s = guard.grant(s, op["id"], cls["kind"], digest(op["args"]), proposal=op["proposal"], at=op["at"])
        elif op["op"] == "signal":
            s = guard.signal(s, op["name"], op["at"])
        elif op["op"] == "void":
            s = guard.void_approval(s, op["id"])
        assert digest(s) == step["stateDigest"], f"{where}: state"


@pytest.mark.parametrize("case", json.loads((CONF / "guard.json").read_text(encoding="utf-8"))["cases"], ids=lambda c: c["name"])
def test_guard_vectors_decide_the_same_through_the_binding(case):
    _replay(case, check_classification=False)


@pytest.mark.parametrize("case", json.loads((CONF / "routed-guard.json").read_text(encoding="utf-8"))["cases"], ids=lambda c: c["name"])
def test_routed_guard_vectors_decide_the_same_through_the_binding(case):
    _replay(case, check_classification=True)
    # And the binding's own routing reaches those targets from the generic tool's arguments.
    for step in case["steps"]:
        op = step["op"]
        base, _, tool_name = op["activity"].partition(":")
        if tool_name and base in (case["policy"].get("routes") or {}) and isinstance(op.get("args"), list) \
                and op["args"] and isinstance(op["args"][0], dict) and op["args"][0].get("tool_name") == tool_name:
            assert route_target(case["policy"], base, op["args"]) == op["activity"]


# ---- the kernel stays engine-neutral --------------------------------------------

def test_the_binding_does_not_import_temporalio():
    code = ("import sys, polyflow_langgraph, polyflow_temporal.sinks; "
            "assert 'temporalio' not in sys.modules, sorted(m for m in sys.modules if m.startswith('temporalio'))")
    subprocess.run([sys.executable, "-c", code], check=True, cwd=PLATFORM / "python")


def test_a_checkpoint_id_carries_its_time():
    from langgraph.checkpoint.base.id import uuid6
    import time
    before = int(time.time() * 1000)
    ms = checkpoint_ms(str(uuid6()))
    assert before - 1 <= ms <= int(time.time() * 1000) + 1
    assert checkpoint_ms("not-a-uuid") is None and checkpoint_ms(str(uuid.uuid4())) is None


def test_guard_level_needs_an_admitted_policy():
    with pytest.raises(ValueError, match="ADMITTED"):
        Governor(level="guard", policy={"policy": "x"})
