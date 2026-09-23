"""S2 (plan P7.3): an OpenAI Agents SDK agent on Temporal, governed at G1 by
the Python PolyflowPlugin, with no change to the agent's code.

The model is scripted (the SDK's own testing ``ResponseBuilders``), so no
OpenAI key is needed: it reads the ticket, refunds it, then tries to refund it
a second time, the double refund a looping agent makes. The policy
(policy.json) routes the one MCP activity by the tool it carries, and allows
one refund, after a read. The second refund is refused before it reaches the
MCP server; the agent reads the refusal, and why, as the tool's output.

    python run.py            # needs node (for `polyflow policy` / `verify`) and a Temporal dev server download
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

from agents import Model, ModelResponse
from temporalio.client import Client
from temporalio.contrib.openai_agents import ModelActivityParameters, StatelessMCPServerProvider
from temporalio.contrib.openai_agents.testing import AgentEnvironment, ResponseBuilders
from temporalio.worker import Worker

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(1, str(HERE.parents[1]))  # polyflow_temporal, when it is not installed
PLATFORM = HERE.parents[2]
CLI = PLATFORM / "packages" / "cli" / "bin" / "polyflow.mjs"

from polyflow_temporal.plugin import PolyflowPlugin  # noqa: E402
from support_agent import SupportAgent  # noqa: E402
from tickets_server import TicketsServer  # noqa: E402


class ScriptedModel(Model):
    """Returns the scripted responses in order, and keeps what it was shown each turn,
    so a test can check what the agent saw (a tool result, or a refusal)."""

    def __init__(self, responses: list[ModelResponse]):
        self._responses = iter(responses)
        self.inputs: list[Any] = []

    async def get_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs, tracing, **kwargs) -> ModelResponse:
        self.inputs.append(input)
        return next(self._responses)

    def stream_response(self, *args, **kwargs):
        raise NotImplementedError


def double_refund_script() -> list[ModelResponse]:
    refund = json.dumps({"id": "T-1", "amount": 40})
    return [
        ResponseBuilders.tool_call(json.dumps({"id": "T-1"}), "read_ticket"),
        ResponseBuilders.tool_call(refund, "issue_refund"),
        ResponseBuilders.tool_call(refund, "issue_refund"),  # the second, forbidden refund
        ResponseBuilders.output_message("Refunded $40 for T-1."),
    ]


def admit(path: Path = HERE / "policy.json") -> dict:
    """`polyflow policy`: admission runs once, in the TypeScript toolchain."""
    out = subprocess.run(["node", str(CLI), "policy", str(path)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


async def run_sample(client: Client, *, sink, policy: dict, signing_key: dict | None = None, model: ScriptedModel | None = None,
                     workflow_id: str | None = None) -> tuple[str, ScriptedModel, str]:
    model = model or ScriptedModel(double_refund_script())
    workflow_id = workflow_id or f"s2-support-{uuid.uuid4()}"
    tickets = StatelessMCPServerProvider("Tickets", lambda: TicketsServer())
    async with AgentEnvironment(model=model, mcp_server_providers=[tickets], model_params=ModelActivityParameters()) as agents_env:
        agents_client = agents_env.applied_on_client(client)
        tq = f"s2-{uuid.uuid4()}"
        async with Worker(agents_client, task_queue=tq, workflows=[SupportAgent],
                          plugins=[PolyflowPlugin(level="guard", policy=policy, sink=sink, signing_key=signing_key)]):
            out = await agents_client.execute_workflow(SupportAgent.run, "Ticket T-1: the parcel arrived broken, please refund.",
                                                       id=workflow_id, task_queue=tq)
    return out, model, workflow_id


async def main() -> None:
    from temporalio.testing import WorkflowEnvironment

    from polyflow_temporal.plugin import FileSink

    work = Path(tempfile.mkdtemp(prefix="polyflow-s2-"))
    root, keys = work / "ledger", work / "keys"
    subprocess.run(["node", str(CLI), "keygen", "--id", "s2-worker", "--out", str(keys)], check=True, capture_output=True)
    key = json.loads((keys / "s2-worker.key.json").read_text())
    env = await WorkflowEnvironment.start_local()
    try:
        out, _, wid = await run_sample(env.client, sink=FileSink(root), policy=admit(), signing_key=key)
    finally:
        await env.shutdown()
    print(f"agent: {out}")
    for f in root.rglob("*.jsonl"):
        if f.name.endswith(".heads.jsonl") or wid not in str(f.parent):
            continue
        for line in f.read_text(encoding="utf-8").splitlines():
            e = json.loads(line)
            b = e["body"]
            print(f"{e['seq']:>3} {e['kind']:<11} {b.get('route') or b.get('activityType') or b.get('action') or b.get('outcome') or ''} {b.get('rules') or ''}")
        print(subprocess.run(["node", str(CLI), "verify", str(f), "--trust", str(keys / "trust.json")], capture_output=True, text=True).stdout)


if __name__ == "__main__":
    asyncio.run(main())
