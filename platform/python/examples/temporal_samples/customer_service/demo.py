"""Temporal's `openai_agents/customer_service` sample, governed at G1.

The workflow (an airline triage agent that hands off to an FAQ agent or a
seat-booking agent, driven by the `process_user_message` Update, with
continue-as-new) is byte for byte the official sample (upstream.json). The
tools moved onto the "Airline" MCP server, and the worker gained one
`PolyflowPlugin(level="guard", ...)` line with policy.json.

The model is scripted (the SDK's own testing ``ResponseBuilders``), so no
OpenAI key is needed. The conversation is the one a looping or hallucinating
agent has: it changes the seat before looking the booking up, changes it, tries
to change it again, then tries a tool the policy never named.

    python demo.py            # needs node (`polyflow policy` / `verify`) and a Temporal dev server download
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
from temporalio.client import Client, WorkflowFailureError
from temporalio.contrib.openai_agents import ModelActivityParameters, StatelessMCPServerProvider
from temporalio.contrib.openai_agents.testing import AgentEnvironment, ResponseBuilders
from temporalio.worker import Worker

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))            # the sample's package, `openai_agents`
sys.path.insert(1, str(HERE.parents[2]))  # polyflow_temporal, when it is not installed
PLATFORM = HERE.parents[3]
CLI = PLATFORM / "packages" / "cli" / "bin" / "polyflow.mjs"

from openai_agents.customer_service import airline_server  # noqa: E402
from openai_agents.customer_service.customer_service import ProcessUserMessageInput  # noqa: E402
from openai_agents.customer_service.workflows.customer_service_workflow import CustomerServiceWorkflow  # noqa: E402
from polyflow_temporal.plugin import PolyflowPlugin  # noqa: E402

MCP = "Airline-stateless-call-tool-v2"


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


def call(name: str, **args) -> ModelResponse:
    return ResponseBuilders.tool_call(json.dumps(args), name)


def say(text: str) -> ModelResponse:
    return ResponseBuilders.output_message(text)


# Each turn is one `process_user_message` Update: the user's text, then the
# model's responses for that turn, in order.
CONVERSATION: list[tuple[str, list[ModelResponse]]] = [
    ("Hi, I'd like to change my seat.", [
        call("transfer_to_seat_booking_agent"),
        say("Of course. What is your confirmation number, and which seat would you like?"),
    ]),
    ("ABC123, seat 12A please.", [
        call("update_seat", confirmation_number="ABC123", new_seat="12A"),   # refused: no lookup yet
        call("get_booking", confirmation_number="ABC123"),
        call("update_seat", confirmation_number="ABC123", new_seat="12A"),   # allowed
        say("Done: seat 12A on flight FLT-512 for ABC123."),
    ]),
    ("Actually, make it 14C.", [
        call("update_seat", confirmation_number="ABC123", new_seat="14C"),   # refused: one change per conversation
        say("I can change a seat once per conversation; a colleague will help with a further change."),
    ]),
    ("Then cancel the booking.", [
        call("cancel_booking", confirmation_number="ABC123"),                # refused: the policy never named it
        say("I am not able to cancel bookings here."),
    ]),
]


def admit(path: Path = HERE / "policy.json") -> dict:
    """`polyflow policy`: admission runs once, in the TypeScript toolchain."""
    out = subprocess.run(["node", str(CLI), "policy", str(path)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


async def run_conversation(client: Client, *, sink, policy: dict, signing_key: dict | None = None,
                           conversation=CONVERSATION, workflow_id: str | None = None) -> tuple[list[str], ScriptedModel, str]:
    model = ScriptedModel([r for _, responses in conversation for r in responses])
    workflow_id = workflow_id or f"airline-{uuid.uuid4()}"
    airline = StatelessMCPServerProvider("Airline", airline_server.AirlineServer)
    async with AgentEnvironment(model=model, mcp_server_providers=[airline], model_params=ModelActivityParameters()) as agents_env:
        agents_client = agents_env.applied_on_client(client)
        tq = f"airline-{uuid.uuid4()}"
        async with Worker(agents_client, task_queue=tq, workflows=[CustomerServiceWorkflow],
                          plugins=[PolyflowPlugin(level="guard", policy=policy, sink=sink, signing_key=signing_key)]):
            handle = await agents_client.start_workflow(CustomerServiceWorkflow.run, id=workflow_id, task_queue=tq)
            history: list[str] = []
            for user_input, _ in conversation:
                new = await handle.execute_update(CustomerServiceWorkflow.process_user_message,
                                                  ProcessUserMessageInput(user_input=user_input, chat_length=len(history)))
                history.extend(new)
            # The sample's workflow lives until continue-as-new is suggested; end this
            # conversation so its chain closes.
            await handle.cancel()
            try:
                await handle.result()
            except WorkflowFailureError:
                pass
    return history, model, workflow_id


def ledger_files(root: Path, workflow_id: str) -> list[Path]:
    return [f for f in root.rglob("*.jsonl") if not f.name.endswith(".heads.jsonl") and workflow_id in str(f.parent)]


async def main() -> None:
    from temporalio.testing import WorkflowEnvironment

    from polyflow_temporal.plugin import FileSink

    work = Path(tempfile.mkdtemp(prefix="polyflow-airline-"))
    root, keys = work / "ledger", work / "keys"
    subprocess.run(["node", str(CLI), "keygen", "--id", "airline-worker", "--out", str(keys)], check=True, capture_output=True)
    key = json.loads((keys / "airline-worker.key.json").read_text())
    env = await WorkflowEnvironment.start_local()
    try:
        history, _, wid = await run_conversation(env.client, sink=FileSink(root), policy=admit(), signing_key=key)
    finally:
        await env.shutdown()
    print(*history, sep="\n")
    print()
    for f in ledger_files(root, wid):
        for line in f.read_text(encoding="utf-8").splitlines():
            e = json.loads(line)
            b = e["body"]
            print(f"{e['seq']:>3} {e['kind']:<11} {b.get('route') or b.get('activityType') or b.get('action') or b.get('outcome') or ''} {b.get('rules') or ''}")
        print(subprocess.run(["node", str(CLI), "verify", str(f), "--trust", str(keys / "trust.json")], capture_output=True, text=True).stdout)


if __name__ == "__main__":
    asyncio.run(main())
