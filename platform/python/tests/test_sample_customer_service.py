"""Temporal's official `openai_agents/customer_service` sample on Polyflow at G1
(examples/temporal_samples/customer_service). The workflow is byte for byte
upstream's (checked by examples/upstream/check.mjs); the tools moved onto an
MCP server and the worker gained one plugin line. Scripted model, no key.

(a) a seat change before a booking lookup is refused with a witness, and the
    agent is shown why; after the lookup the same call goes through, once;
(b) a second seat change in the conversation is refused (`at-most`);
(c) a tool the policy never named (`cancel_booking`) is refused, routed and
    undeclared, and never reaches the server;
(d) the chain records every model call and every tool by its routed name, and
    the TypeScript `polyflow verify` accepts it, signed and closed;
(e) the Update-driven workflow schedules its first activity from an Update
    handler, before the workflow function runs (the plugin creates the chain
    on first use).
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("agents", reason="the sample needs temporalio[openai-agents]")

from temporalio.testing import WorkflowEnvironment  # noqa: E402

from polyflow_temporal.ledger import verify_chain  # noqa: E402
from polyflow_temporal.plugin import FileSink  # noqa: E402

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "temporal_samples" / "customer_service"
sys.path.insert(0, str(EXAMPLE))

import demo  # noqa: E402
from openai_agents.customer_service import airline_server  # noqa: E402

MCP = demo.MCP


@pytest.fixture(scope="module")
async def env():
    e = await WorkflowEnvironment.start_local()
    yield e
    await e.shutdown()


def test_the_workflow_is_byte_identical_to_upstream():
    check = EXAMPLE.parents[3] / "examples" / "upstream" / "check.mjs"
    res = subprocess.run(["node", str(check), str(EXAMPLE)], capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "identical  openai_agents/customer_service/workflows/customer_service_workflow.py" in res.stdout


async def test_the_official_customer_service_sample_is_governed_at_g1(env, tmp_path):
    subprocess.run(["node", str(demo.CLI), "keygen", "--id", "airline", "--out", str(tmp_path / "keys")], check=True, capture_output=True)
    key = json.loads((tmp_path / "keys" / "airline.key.json").read_text())
    policy = demo.admit()
    assert policy["routes"] == {MCP: "0.tool_name"}
    airline_server.SEAT_CHANGES.clear()
    airline_server.BOOKINGS["ABC123"]["seat_number"] = "9C"

    history, model, wid = await demo.run_conversation(env.client, sink=FileSink(tmp_path / "ledger"), policy=policy, signing_key=key)

    files = demo.ledger_files(tmp_path / "ledger", wid)
    assert len(files) == 1
    events = [json.loads(line) for line in files[0].read_text(encoding="utf-8").splitlines()]
    assert verify_chain(events)["ok"]
    verdicts = [e["body"] for e in events if e["kind"] == "verdict"]
    denied = [v for v in verdicts if v["outcome"] == "denied"]
    assert len(denied) == 3

    # (a) refused before the lookup, with a witness naming the rule and the fix; then once.
    assert denied[0]["rules"] == ["booking-after-lookup"]
    w = denied[0]["witness"]
    assert w["candidate"]["target"] == MCP and "booking" not in w["allowedNow"]
    first_refusal = json.dumps(model.inputs[3], default=str)  # what the model saw after its refused call
    assert "booking-after-lookup" in first_refusal and "run 'read'" in first_refusal
    assert airline_server.SEAT_CHANGES == [{"confirmation_number": "ABC123", "new_seat": "12A"}]
    assert "Done: seat 12A on flight FLT-512 for ABC123." in " ".join(history)

    # (b) the second change is refused: one per conversation.
    assert "one-seat-change" in denied[1]["rules"]
    assert denied[1]["witness"]["counters"] == {"scheduled": 1, "succeeded": 1}

    # (c) the undeclared tool is refused, routed, and the server never saw it.
    assert denied[2]["rules"] == ["unlabelled"]
    assert "ABC123" in airline_server.BOOKINGS

    # (d) every model call and every tool by its routed name; the TS verifier accepts the chain.
    effects = [e["body"] for e in events if e["kind"] == "effect"]
    assert sum(1 for b in effects if b["activityType"] == "invoke_model_activity") == len(model.inputs)
    assert [b["route"] for b in effects if b["activityType"] == MCP] == [f"{MCP}:get_booking", f"{MCP}:update_seat"]
    assert events[-1]["kind"] == "closure" and events[-1]["body"]["outcome"] == "cancelled"
    res = subprocess.run(["node", str(demo.CLI), "verify", str(files[0]), "--trust", str(tmp_path / "keys" / "trust.json")],
                         capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "consistent, closed and signed" in res.stdout

    # (e) the first effect came from the Update handler, not the workflow function.
    assert [e["kind"] for e in events[:4]] == ["admission", "proposal", "verdict", "effect"]
    assert events[3]["body"]["activityType"] == "invoke_model_activity"
