"""S2 (plan P7.3): an unmodified OpenAI Agents SDK agent on Temporal, governed
at G1 by the Python plugin. The sample is examples/openai_agents/; this test
runs it on a dev server with a scripted model (no OpenAI key) and checks:

(a) the ledger records the model calls, and each MCP tool call by its ROUTED
    name (one activity, many tools: plan P7.3a);
(b) the guard refuses the second refund before it reaches the MCP server, and
    the agent is shown the refusal and why, as the tool's output;
(c) the TypeScript `polyflow verify` accepts the Python ledger, signed.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("agents", reason="the S2 sample needs temporalio[openai-agents]")

from temporalio.testing import WorkflowEnvironment  # noqa: E402

from polyflow_temporal.ledger import verify_chain  # noqa: E402
from polyflow_temporal.plugin import FileSink  # noqa: E402

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "openai_agents"
sys.path.insert(0, str(EXAMPLE))

import run as s2  # noqa: E402
import tickets_server  # noqa: E402

MCP = "Tickets-stateless-call-tool-v2"


@pytest.fixture(scope="module")
async def env():
    e = await WorkflowEnvironment.start_local()
    yield e
    await e.shutdown()


async def test_s2_an_unmodified_openai_agent_is_governed_and_its_ledger_verifies(env, tmp_path):
    subprocess.run(["node", str(s2.CLI), "keygen", "--id", "s2", "--out", str(tmp_path / "keys")], check=True, capture_output=True)
    key = json.loads((tmp_path / "keys" / "s2.key.json").read_text())
    policy = s2.admit()
    assert policy["routes"] == {MCP: "0.tool_name"}
    tickets_server.REFUNDS.clear()

    out, model, wid = await s2.run_sample(env.client, sink=FileSink(tmp_path / "ledger"), policy=policy, signing_key=key)
    assert out == "Refunded $40 for T-1."

    files = [p for p in (tmp_path / "ledger").rglob("*.jsonl") if not p.name.endswith(".heads.jsonl")]
    assert len(files) == 1
    events = [json.loads(line) for line in files[0].read_text(encoding="utf-8").splitlines()]
    assert verify_chain(events)["ok"]

    # (a) model calls and each MCP tool, by its routed name.
    effects = [e["body"] for e in events if e["kind"] == "effect"]
    assert sum(1 for b in effects if b["activityType"] == "invoke_model_activity") == 4
    routed = [b["route"] for b in effects if b["activityType"] == MCP]
    assert routed == [f"{MCP}:read_ticket", f"{MCP}:issue_refund"], routed
    assert {b["kind"] for b in effects if b["activityType"] == MCP} == {"read", "refund"}

    # (b) the second refund is refused, never reaches the server, and the agent is told why.
    denied = [e["body"] for e in events if e["kind"] == "verdict" and e["body"]["outcome"] == "denied"]
    # Both rules refuse it: a read licenses one refund (requires-prior consumes), and one refund per run.
    assert len(denied) == 1 and denied[0]["rules"] == ["read-before-refund", "one-refund"]
    witness = denied[0]["witness"]
    assert witness["candidate"]["target"] == MCP and witness["counters"] == {"scheduled": 1, "succeeded": 1}
    assert "refund" not in witness["allowedNow"]
    assert tickets_server.REFUNDS == [{"id": "T-1", "amount": 40}], "exactly one refund was issued"
    shown = json.dumps(model.inputs[-1], default=str)
    assert "one-refund" in shown and "at most 1 time(s)" in shown, "the agent sees the refusal and its reason"

    # (c) the TypeScript verifier accepts the Python ledger: consistent, closed and signed.
    res = subprocess.run(["node", str(s2.CLI), "verify", str(files[0]), "--trust", str(tmp_path / "keys" / "trust.json")],
                         capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "consistent, closed and signed" in res.stdout
