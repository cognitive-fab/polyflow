"""P6-P8 review: failing tests for the Python port and plugin.

Each test asserts what the technical spec (§3.2, §10) or the TypeScript
plugin it claims parity with does, and fails today for the reason in its
message. See docs/platform/reviews/P6-P8-review.md.
"""

import asyncio
import json
import subprocess
import uuid
from pathlib import Path

import pytest
from temporalio.client import WorkflowFailureError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from polyflow_temporal.plugin import FileSink, MemorySink, PolyflowPlugin
from polyflow_temporal.rules import Guard

from review_p6p8_workflows import (
    Courier, DelegatingAgent, LeakyAgent, SpendingAgent, WaitingAgent, leaky_tool, llm, search,
)

PLATFORM = Path(__file__).resolve().parents[2]
CLI = PLATFORM / "packages" / "cli" / "bin" / "polyflow.mjs"


def admit(raw: dict) -> dict:
    src = PLATFORM / "python" / f".tmp-review-policy-{uuid.uuid4().hex[:8]}.json"
    src.write_text(json.dumps(raw))
    try:
        out = subprocess.run(["node", str(CLI), "policy", str(src)], capture_output=True, text=True, check=True)
    finally:
        src.unlink()
    return json.loads(out.stdout)


# ---- pure: no server ----------------------------------------------------------

def test_PYC1_a_metered_budget_reads_through_arrays_like_typescript():
    # The TS kernel's `pick` walks any object, arrays included: {items:[{n:2}]}
    # at 'items.0.n' reads 2 (and a string result at 'length' reads its length).
    # The port reads nothing, so the two guards' states diverge from here on.
    policy = {
        "policy": "p", "version": 1, "digest": "sha256:x", "unlabelled": "deny", "kinds": ["model"],
        "effects": {"llm": {"kind": "model", "class": "none", "labels": []}},
        "rules": [{"id": "items", "type": "budget", "metric": "items", "from": "items.0.n", "max": 3, "outcome": "deny"}],
    }
    g = Guard(policy)
    s = g.observe(g.init(), "model", True, labels=[], result={"items": [{"n": 2}]})
    assert s["meters"].get("items") == 2, "PYC1: the Python guard spends nothing where the TypeScript guard spends 2"


def test_PYS1_a_file_sink_reports_a_different_event_at_a_held_seq(tmp_path):
    # TS fileSink returns {conflicts:[seq]} and the exporter raises the tamper
    # alarm (tech spec §11). The Python FileSink drops the second event silently.
    sink = FileSink(tmp_path)
    run = {"ns": "default", "wf": "w", "run": "r"}
    a = {"v": 1, "run": run, "seq": 0, "kind": "admission", "at": 1, "body": {}, "prev": "sha256:g", "hash": "sha256:aaa"}
    b = {**a, "body": {"level": "observe"}, "hash": "sha256:bbb"}
    sink.write([a], None)
    r = sink.write([b], None)
    assert r and r.get("conflicts") == [0], "PYS1: a conflicting event at seq 0 is dropped without a word"


# ---- on a dev server ------------------------------------------------------------

@pytest.fixture(scope="module")
async def env():
    e = await WorkflowEnvironment.start_local()
    yield e
    await e.shutdown()


async def _run(env, plugin, workflows, activities, wf, wid, *args):
    tq = f"rv-{uuid.uuid4()}"
    async with Worker(env.client, task_queue=tq, workflows=workflows, activities=activities, plugins=[plugin], max_cached_workflows=0):
        return await env.client.execute_workflow(wf, *args, id=wid, task_queue=tq)


async def test_PYR1_failure_text_is_redacted_before_it_is_recorded(env):
    sink = MemorySink()
    await _run(env, PolyflowPlugin(sink=sink), [LeakyAgent], [leaky_tool], LeakyAgent.run, "rv-leak")
    events, _ = sink.read("rv-leak")
    errors = [e["body"].get("error", "") for e in events if e["kind"] == "observation" and not e["body"]["ok"]]
    assert errors, "the failed tool call is observed"
    assert not any("sk-live-0123456789abcdefghij" in x for x in errors), f"PYR1: a credential reached the ledger: {errors}"


async def test_PYB1_a_metered_budget_is_spent_by_a_dataclass_result(env):
    policy = admit({
        "policy": "spend", "version": 1, "unlabelled": "deny",
        "effects": {"llm": {"kind": "model", "class": "none"}},
        "rules": [{"id": "usd", "type": "budget", "metric": "usd", "from": "usd", "max": 1, "kinds": ["model"]}],
    })
    out = await _run(env, PolyflowPlugin(level="guard", policy=policy, sink=MemorySink()), [SpendingAgent], [llm], SpendingAgent.run, "rv-spend")
    assert out[1].startswith("denied:PolyflowDenied"), f"PYB1: $5 spent against a $1 budget, and the next call still ran: {out}"


async def test_PYG1_a_child_workflow_is_an_effect_the_guard_decides(env):
    sink = MemorySink()
    policy = admit({
        "policy": "narrow", "version": 1, "unlabelled": "deny",
        "effects": {"search": {"kind": "search", "class": "none"}},
        "rules": [],
    })
    out = await _run(env, PolyflowPlugin(level="guard", policy=policy, sink=sink), [DelegatingAgent, Courier], [search], DelegatingAgent.run, "rv-child")
    events, _ = sink.read("rv-child")
    actions = [e["body"].get("action") for e in events if e["kind"] == "proposal"]
    assert "Courier" in actions and out.startswith("denied"), f"PYG1: the child workflow ran unrecorded and unguarded ({out}); proposals: {actions}"


async def test_PYX1_a_cancelled_run_ends_its_record_with_a_closure(env):
    sink = MemorySink()
    tq = f"rv-{uuid.uuid4()}"
    async with Worker(env.client, task_queue=tq, workflows=[WaitingAgent], activities=[search], plugins=[PolyflowPlugin(sink=sink)], max_cached_workflows=0):
        h = await env.client.start_workflow(WaitingAgent.run, id="rv-cancel", task_queue=tq)
        for _ in range(100):
            events, _ = sink.read("rv-cancel")
            if events:
                break
            await asyncio.sleep(0.1)
        await h.cancel()
        with pytest.raises(WorkflowFailureError):
            await h.result()
        await asyncio.sleep(1.0)
    events, _ = sink.read("rv-cancel")
    kinds = [e["kind"] for e in events]
    assert kinds and kinds[-1] == "closure", f"PYX1: a cancelled workflow leaves an open ledger: {kinds}"
