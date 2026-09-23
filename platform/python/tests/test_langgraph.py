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

from polyflow_langgraph import Governor, checkpoint_ms, govern, govern_effect, idempotency_key, observe_effect, verify_thread  # noqa: E402
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
    tools.governor.close(cfg("a"))

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
    assert effects[1]["idempotencyKey"] == idempotency_key(events[0]["run"], effects[1]["id"])
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
    tools.governor.close(cfg("async"))
    events, _ = chain(sink, "async")
    assert verify_chain(events)["ok"] and events[-1]["kind"] == "closure"
    assert [e["body"]["outcome"] for e in events if e["kind"] == "verdict"] == ["denied", "allowed", "allowed", "denied"]
    assert json.loads(out["messages"][-2].content)["error"] == "PolyflowDenied"


def test_observe_records_without_a_policy():
    sink = MemorySink()
    tools = govern([read_ticket, issue_refund], sink=sink)
    graph = agent(tools, REFUND_SCRIPT)
    graph.invoke({"messages": [("user", "refund T1")]}, cfg("g0"))
    tools.governor.close(cfg("g0"))
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
    tools.governor.close(cfg("routed"))
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
    second.governor.close(cfg("c"))

    events, _ = chain(sink, "c")
    assert verify_chain(events)["ok"]
    assert sum(e["kind"] == "admission" for e in events) == 1
    assert [e["body"]["activityType"] for e in events if e["kind"] == "effect"] == ["read_ticket", "issue_refund"]
    assert [e["body"]["outcome"] for e in events if e["kind"] == "verdict"] == ["allowed", "allowed", "denied"]
    # The thread's record (beside the sink) is at the sink's head, and the thread verifies as one record.
    assert second.governor.snapshot("c")["head"] == {"seq": events[-1]["seq"], "hash": events[-1]["hash"]}
    assert verify_thread(sink, "c")["ok"]
    assert out["messages"][-1].content.startswith("final")


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
    tools3.governor.close(cfg("crash"))

    assert CALLS.count(("read_ticket", "T2")) == 2 and CALLS.count(("issue_refund", "T1")) == 2
    assert conflicts == []  # every re-run derived the events the sink already held
    events, _ = chain(sink, "crash")
    assert verify_chain(events)["ok"]
    effects = [e["body"] for e in events if e["kind"] == "effect"]
    # Each proposed call is ONE effect, however often it ran; the re-run refund is the
    # same effect (same idempotency key), not a second refund the budget would refuse.
    assert [b["activityType"] for b in effects] == ["read_ticket", "read_ticket", "issue_refund"]
    assert len({b["idempotencyKey"] for b in effects}) == 3
    # The re-executions are recorded, not hidden: the observation says how many attempts it took.
    attempts = {e["body"]["effect"]: e["body"].get("attempts", 1) for e in events if e["kind"] == "observation"}
    assert attempts[effects[1]["id"]] == 2 and attempts[effects[2]["id"]] == 2 and attempts[effects[0]["id"]] in (1, 2)
    assert verify_thread(sink, "crash")["ok"]
    assert [e["body"]["outcome"] for e in events if e["kind"] == "verdict"] == ["allowed", "allowed", "allowed", "denied"]
    snap = tools3.governor.snapshot("crash")
    assert snap["guard"]["n"] == {"read": 2, "refund": 1}
    assert snap["guard"]["ok"] == {"read": 2, "refund": 1}


def test_a_closed_thread_that_goes_on_starts_a_linked_chain(refunds_policy):
    saver, sink = InMemorySaver(), MemorySink()
    branches = []
    tools = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink,
                   on_conflict=lambda run, seqs: branches.append((run["run"], seqs)))
    graph = agent(tools, REFUND_SCRIPT[1:3], saver)
    graph.invoke({"messages": [("user", "refund T1")]}, cfg("more"))
    closed = tools.governor.close(cfg("more"))
    assert tools.governor.close(cfg("more"))["head"] == closed["head"]  # idempotent
    # The user comes back to the same thread; the model tries a second refund.
    more = agent(tools, REFUND_SCRIPT[1:3] + [[], [call("issue_refund", "c9", ticket="T1", amount=25)]], saver)
    more.invoke({"messages": [("user", "and again")]}, cfg("more"))
    assert branches == []  # the record knows the chain was closed: a linked chain, not a conflict
    old = [r for k, r in sink.runs.items() if k[2] == closed["run"]["run"]][0]
    new = [r for k, r in sink.runs.items() if k[1] == "more" and k[2] != closed["run"]["run"]][0]
    new_events = [new["events"][s] for s in sorted(new["events"])]
    assert verify_chain(new_events)["ok"]
    link = new_events[0]["body"]["continues"]
    assert link["run"] == closed["run"] and old["events"][link["seq"]]["hash"] == link["hash"]
    # The guard state belongs to the thread: the refund budget is still spent.
    assert [e["body"]["outcome"] for e in new_events if e["kind"] == "verdict"] == ["denied"]
    assert verify_thread(sink, "more")["ok"]


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
    second.governor.close(cfg("ts"))

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


# ---- after the P10 review --------------------------------------------------------

def test_verify_thread_reports_unlinked_chains_and_effects_without_an_allowed_verdict():
    from polyflow_temporal.ledger import Ledger
    sink = MemorySink()
    for run_id in ("r1", "r2"):   # two chains for one thread, neither linked to the other
        led = Ledger({"ns": "langgraph", "wf": "t", "run": run_id})
        led.append("admission", {"level": "guard", "execution": {"engine": "langgraph", "thread": "t"}}, 1)
        led.append("proposal", {"source": "model", "action": "issue_refund"}, 2)
        led.append("verdict", {"proposal": "p1", "outcome": "denied", "rules": ["one-refund"]}, 2)
        led.append("effect", {"id": "e3", "proposal": "p1", "kind": "refund"}, 2)
        sink.write(led.events(), None)
    r = verify_thread(sink, "t")
    assert not r["ok"]
    assert any("2 unlinked chains" in p for p in r["problems"])
    assert any("does not follow an allowed verdict" in p for p in r["problems"])
    assert any("2 open chains" in p for p in r["problems"])


def test_a_thread_whose_record_is_missing_while_its_ledger_exists_is_refused(refunds_policy):
    sink = MemorySink()
    tools = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink)
    agent(tools, REFUND_SCRIPT[1:3]).invoke({"messages": [("user", "refund T1")]}, cfg("lost"))
    sink._polyflow_threads = None   # the record is lost; the ledger is not
    CALLS.clear()
    fresh = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink)
    out = agent(fresh, REFUND_SCRIPT[1:3]).invoke({"messages": [("user", "refund T1")]}, cfg("lost"))
    assert CALLS == []   # never a fresh guard over a thread that already spent
    assert "record-missing" in [m for m in out["messages"] if isinstance(m, ToolMessage)][0].content


def test_no_checkpointer_is_refused_unless_explicitly_allowed(refunds_policy):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        refused = create_react_agent(ScriptedModel(script=REFUND_SCRIPT[1:2]), govern([read_ticket, issue_refund]))
        allowed = create_react_agent(ScriptedModel(script=REFUND_SCRIPT[1:2]), govern([read_ticket, issue_refund], allow_unthreaded=True))
    out = refused.invoke({"messages": [("user", "x")]})
    assert CALLS == [] and "PolyflowRefused" in out["messages"][2].content
    allowed.invoke({"messages": [("user", "x")]})
    assert CALLS == [("read_ticket", "T1")]


def test_the_typescript_cli_verifies_a_thread_of_linked_chains(refunds_policy, tmp_path):
    # VF1: `polyflow verify --thread <dir>` checks every chain of a thread as one record.
    key_dir = tmp_path / "keys"
    subprocess.run(["node", str(CLI), "keygen", "--id", "lg-worker", "--out", str(key_dir)], check=True, capture_output=True)
    key = json.loads((key_dir / "lg-worker.key.json").read_text())
    saver, root = InMemorySaver(), tmp_path / "ledger"
    tools = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=FileSink(root), signing_key=key)
    graph = agent(tools, REFUND_SCRIPT[1:3], saver)
    graph.invoke({"messages": [("user", "refund T1")]}, cfg("linked"))
    tools.governor.close(cfg("linked"))
    # The thread continues after close: a second chain, linked to the first closure.
    graph2 = agent(tools, REFUND_SCRIPT[1:3] + [[], [call("issue_refund", "c9", ticket="T1", amount=25)]], saver)
    graph2.invoke({"messages": [("user", "again")]}, cfg("linked"))
    tools.governor.close(cfg("linked"))
    dirs = {p.parent for p in root.rglob("*.jsonl") if not p.name.endswith(".heads.jsonl")}
    assert len(dirs) == 1
    thread_dir = dirs.pop()
    run = lambda: subprocess.run(["node", str(CLI), "verify", "--thread", str(thread_dir), "--trust", str(key_dir / "trust.json")], capture_output=True, text=True)
    out = run()
    assert out.returncode == 0, out.stdout + out.stderr
    assert "  link        " in out.stdout and "one thread: every chain verifies" in out.stdout, out.stdout
    # An unlinked chain dropped into the thread's directory is refused.
    first = sorted(p for p in thread_dir.glob("*.jsonl") if not p.name.endswith(".heads.jsonl"))[0]
    rogue = thread_dir / "rogue.jsonl"
    lines = first.read_text().splitlines()
    from polyflow_temporal.ledger import Ledger
    led = Ledger({"ns": json.loads(lines[0])["run"]["ns"], "wf": json.loads(lines[0])["run"]["wf"], "run": "rogue"})
    led.append("admission", {"level": "guard", "execution": {"engine": "langgraph", "thread": "linked"}}, 1)
    led.append("closure", {"outcome": "completed"}, 2)
    rogue.write_text("\n".join(json.dumps(e) for e in led.events()) + "\n")
    out = run()
    assert out.returncode == 1 and "rogue" in out.stdout, out.stdout   # unsigned: nothing anchors it
    unsigned = subprocess.run(["node", str(CLI), "verify", "--thread", str(thread_dir), "--unsigned"], capture_output=True, text=True)
    assert unsigned.returncode == 1 and "unlinked chains" in unsigned.stdout, unsigned.stdout


# ---- after the code review of 1530971 --------------------------------------------

from types import SimpleNamespace  # noqa: E402


def _request(thread, checkpoint, messages, tc):
    info = SimpleNamespace(thread_id=thread, checkpoint_id=checkpoint)
    return SimpleNamespace(runtime=SimpleNamespace(execution_info=info), state={"messages": messages}, tool_call=tc)


def _ok(req):
    return ToolMessage(content="ok", tool_call_id=req.tool_call["id"])


def test_close_folds_an_open_effect_into_the_guard_state_like_a_failed_outcome():
    # An effect left open (the worker died) is observed at close AND folded into the guard:
    # its taint (reads-untrusted) and its trace entry carry into the next linked chain (review 1).
    policy = admit({"policy": "taint", "version": 1,
                    "effects": {"read_ticket": {"kind": "read", "class": "none", "labels": ["reads-untrusted"]}},
                    "rules": [{"id": "one-read", "type": "at-most", "guards": "read", "n": 5}]})
    sink = MemorySink()
    tools = govern([read_ticket, issue_refund], level="guard", policy=policy, sink=sink, handle_tool_errors=False)
    FLAKY["T9"] = 1
    with pytest.raises(RuntimeError):
        agent(tools, [[call("read_ticket", "c1", ticket="T9")]]).invoke({"messages": [("user", "x")]}, cfg("open"))
    tools.governor.close(cfg("open"))
    guard = tools.governor.snapshot("open")["guard"]
    assert guard["taint"]["untrusted"] is True
    assert guard["trace"][-1] == {"seq": 1, "kind": "read", "ok": False}
    events, _ = chain(sink, "open")
    assert [e["kind"] for e in events][-2:] == ["observation", "closure"] and events[-2]["body"]["ok"] is False


def test_a_sink_without_the_protocol_is_refused_at_guard_level_and_runs_of_serves_verify_thread(refunds_policy):
    class BareSink:
        def write(self, events, signed):
            return {"written": len(events), "skipped": 0, "conflicts": []}

    with pytest.raises(ValueError, match="runs_of"):
        govern([read_ticket], level="guard", policy=refunds_policy, sink=BareSink(), store=__import__("polyflow_langgraph").MemoryThreadStore())

    class ProtocolSink(BareSink):
        def __init__(self):
            self.inner = MemorySink()

        def write(self, events, signed):
            return self.inner.write(events, signed)

        def head(self, run):
            return self.inner.head(run)

        def runs_of(self, ns, wf):
            return self.inner.runs_of(ns, wf)

    from polyflow_langgraph import MemoryThreadStore
    sink = ProtocolSink()
    tools = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink, store=MemoryThreadStore())
    agent(tools, REFUND_SCRIPT[1:3]).invoke({"messages": [("user", "x")]}, cfg("proto"))
    tools.governor.close(cfg("proto"))
    assert verify_thread(sink, "proto")["ok"]
    # ...and the fail-closed check goes through the same protocol: a lost record over an existing ledger refuses.
    lost = govern([read_ticket, issue_refund], level="guard", policy=refunds_policy, sink=sink, store=MemoryThreadStore())
    CALLS.clear()
    agent(lost, REFUND_SCRIPT[1:3]).invoke({"messages": [("user", "x")]}, cfg("proto"))
    assert CALLS == []


def test_a_turn_without_an_ai_message_id_is_keyed_by_its_checkpoint_not_mistaken_for_a_replay():
    gov = Governor(sink=MemorySink(), tools=["read_ticket"])
    ran = []
    tc = call("read_ticket", "c1", ticket="T1")
    for ckpt in ("ckpt-1", "ckpt-2"):   # two genuine turns, same call, an AIMessage with no id
        ai = AIMessage(content="", tool_calls=[tc], id=None)
        gov.wrap_tool_call(_request("noid", ckpt, [ai], tc), lambda r: ran.append(r) or _ok(r))
    assert len(ran) == 2
    # ...while a re-run of the SAME checkpoint is still a replay.
    ai = AIMessage(content="", tool_calls=[tc], id=None)
    out = gov.wrap_tool_call(_request("noid", "ckpt-2", [ai], tc), lambda r: ran.append(r) or _ok(r))
    assert len(ran) == 2 and out.response_metadata["polyflow"]["replayed"]


def test_a_subagent_with_its_own_message_list_is_not_reported_as_a_fork_but_a_real_fork_is():
    forks = []
    gov = Governor(sink=MemorySink(), tools=["read_ticket"], on_conflict=lambda run, seqs: forks.append(seqs))
    run = lambda ckpt, msgs, tc: gov.wrap_tool_call(_request("f", ckpt, msgs, tc), _ok)
    tA = call("read_ticket", "a", ticket="A"); aiA = AIMessage(content="", tool_calls=[tA], id="ai-A")
    run("k1", [aiA], tA)
    tB = call("read_ticket", "b", ticket="B"); aiB = AIMessage(content="", tool_calls=[tB], id="ai-B")
    run("k2", [aiB], tB)                      # a subagent: its own list, no lineage to A
    tC = call("read_ticket", "c", ticket="C"); aiC = AIMessage(content="", tool_calls=[tC], id="ai-C")
    run("k3", [aiA, aiC], tC)                 # the main agent goes on from A: B is absent, and that is not a fork
    assert forks == []
    tE = call("read_ticket", "e", ticket="E"); aiE = AIMessage(content="", tool_calls=[tE], id="ai-E")
    run("k4", [aiA, aiE], tE)                 # decided from A again while C (which descends from A) is absent: a fork
    assert len(forks) == 1


def test_a_result_json_cannot_carry_never_leaves_the_effect_open():
    from polyflow_langgraph import MemoryThreadStore
    import datetime
    gov = Governor(sink=MemorySink(), tools=["read_ticket"])
    tc = call("read_ticket", "c1", ticket="T1")
    ai = AIMessage(content="", tool_calls=[tc], id="ai-1")
    ran = []

    def tool(req):
        ran.append(1)
        return ToolMessage(content=[{"type": "text", "text": "x", "when": datetime.date(2026, 9, 23)}], tool_call_id="c1")

    out = gov.wrap_tool_call(_request("odd", "k1", [ai], tc), tool)
    assert out.response_metadata["polyflow"]["effect"]
    again = gov.wrap_tool_call(_request("odd", "k1", [ai], tc), tool)   # a replay: the effect was observed
    assert ran == [1] and again.response_metadata["polyflow"]["replayed"] and "2026-09-23" in json.dumps(again.content)


def test_tool_results_are_kept_beside_the_record_not_in_it(tmp_path):
    from polyflow_langgraph import FileThreadStore
    sink = FileSink(tmp_path / "ledger")
    gov = Governor(sink=sink, tools=["read_ticket"])
    tc = call("read_ticket", "c1", ticket="T1")
    ai = AIMessage(content="", tool_calls=[tc], id="ai-1")
    secret_ish = "the-full-tool-output-" * 50
    gov.wrap_tool_call(_request("blob", "k1", [ai], tc), lambda r: ToolMessage(content=secret_ish, tool_call_id="c1"))
    record = (tmp_path / "ledger" / "langgraph" / "blob" / "thread.state.json").read_text(encoding="utf-8")
    assert secret_ish not in record and len(record) < 4000
    blobs = list((tmp_path / "ledger" / "langgraph" / "blob" / "results").glob("*.json"))
    assert len(blobs) == 1 and secret_ish in blobs[0].read_text(encoding="utf-8")
    assert isinstance(gov.store, FileThreadStore)
    replay = gov.wrap_tool_call(_request("blob", "k1", [ai], tc), lambda r: ToolMessage(content="never", tool_call_id="c1"))
    assert replay.content == secret_ish
