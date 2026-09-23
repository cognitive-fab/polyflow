"""The Python plugin on a real Temporal dev server: G0 records, G1 guards, and
the ledger a Python worker writes is verified by the TypeScript `polyflow
verify` — one record format across languages."""

import json
import shutil
import subprocess
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from temporalio.client import WorkflowFailureError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Replayer, Worker

from polyflow_temporal.ledger import verify_chain
from polyflow_temporal.plugin import FileSink, MemorySink, PolyflowPlugin

PLATFORM = Path(__file__).resolve().parents[2]
CLI = PLATFORM / "packages" / "cli" / "bin" / "polyflow.mjs"


from agent_workflows import AgentLoop, ask_approval, search, slack_send  # noqa: E402


def admitted_policy() -> dict:
    raw = {
        "policy": "comms", "version": 1,
        "effects": {
            "search": {"kind": "search", "class": "none", "labels": ["reads-untrusted"]},
            "ask_approval": {"kind": "approval", "class": "none"},
            "slack_send": {"kind": "post", "class": "irreversible", "labels": ["egress"]},
        },
        "rules": [{"id": "no-post-without-approval", "type": "requires-prior", "guards": "post", "prior": "approval"}],
    }
    src = PLATFORM / "python" / ".tmp-policy.json"
    src.write_text(json.dumps(raw))
    out = subprocess.run(["node", str(CLI), "policy", str(src)], capture_output=True, text=True, check=True)
    src.unlink()
    return json.loads(out.stdout)


@pytest.fixture(scope="module")
async def env():
    e = await WorkflowEnvironment.start_local()
    yield e
    await e.shutdown()


async def run(env, plugin, ask_first, sink_wf):
    tq = f"py-{uuid.uuid4()}"
    async with Worker(env.client, task_queue=tq, workflows=[AgentLoop], activities=[ask_approval, slack_send, search], plugins=[plugin], max_cached_workflows=0):
        result = await env.client.execute_workflow(AgentLoop.run, ask_first, id=sink_wf, task_queue=tq)
    return result


async def test_observe_records_one_effect_per_activity_and_the_chain_verifies(env):
    sink = MemorySink()
    result = await run(env, PolyflowPlugin(sink=sink), True, "py-g0")
    assert result == ["found(tickets)", "yes", "posted:brief"]
    events, _ = sink.read("py-g0")
    assert [e["body"]["activityType"] for e in events if e["kind"] == "effect"] == ["search", "ask_approval", "slack_send"]
    assert events[-1]["kind"] == "closure"
    assert verify_chain(events)["ok"]


async def test_guard_refuses_a_post_without_approval_and_the_agent_sees_why(env):
    sink = MemorySink()
    result = await run(env, PolyflowPlugin(level="guard", policy=admitted_policy(), sink=sink), False, "py-g1")
    assert result[-1].startswith("denied:PolyflowDenied:no-post-without-approval")
    events, _ = sink.read("py-g1")
    verdict = next(e for e in events if e["kind"] == "verdict" and e["body"]["outcome"] == "denied")
    assert verdict["body"]["rules"] == ["no-post-without-approval"]
    # ...and with the approval first, the same agent posts.
    ok = await run(env, PolyflowPlugin(level="guard", policy=admitted_policy(), sink=MemorySink()), True, "py-g1b")
    assert ok[-1] == "posted:brief"


async def test_a_python_ledger_verifies_under_the_typescript_cli(env, tmp_path):
    key_dir = tmp_path / "keys"
    subprocess.run(["node", str(CLI), "keygen", "--id", "py-worker", "--out", str(key_dir)], check=True, capture_output=True)
    key = json.loads((key_dir / "py-worker.key.json").read_text())
    sink = FileSink(tmp_path / "ledger")
    await run(env, PolyflowPlugin(level="guard", policy=admitted_policy(), sink=sink, signing_key=key), True, "py-cross")
    files = [p for p in (tmp_path / "ledger").rglob("*.jsonl") if not p.name.endswith(".heads.jsonl")]
    assert len(files) == 1
    out = subprocess.run(["node", str(CLI), "verify", str(files[0]), "--trust", str(key_dir / "trust.json")], capture_output=True, text=True)
    assert out.returncode == 0, out.stdout + out.stderr
    assert "consistent, closed and signed" in out.stdout


async def test_governed_python_histories_replay_clean(env):
    await run(env, PolyflowPlugin(level="guard", policy=admitted_policy(), sink=MemorySink()), False, "py-replay")
    history = await env.client.get_workflow_handle("py-replay").fetch_history()
    await Replayer(workflows=[AgentLoop], plugins=[PolyflowPlugin(level="guard", policy=admitted_policy(), sink=MemorySink())]).replay_workflow(history)
