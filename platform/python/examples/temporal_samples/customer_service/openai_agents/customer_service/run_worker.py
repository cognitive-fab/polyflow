from __future__ import annotations

import asyncio
import json
from datetime import timedelta
from pathlib import Path

from temporalio.client import Client
from temporalio.contrib.openai_agents import (
    ModelActivityParameters,
    OpenAIAgentsPlugin,
    StatelessMCPServerProvider,
)
from temporalio.worker import Worker

from openai_agents.customer_service.airline_server import AirlineServer
from openai_agents.customer_service.workflows.customer_service_workflow import (
    CustomerServiceWorkflow,
)
from polyflow_temporal.plugin import FileSink, PolyflowPlugin

POLICY = Path(__file__).resolve().parents[2] / "policy.json"


async def main():
    # Create client connected to server at the given address
    client = await Client.connect(
        "localhost:7233",
        plugins=[
            OpenAIAgentsPlugin(
                model_params=ModelActivityParameters(
                    start_to_close_timeout=timedelta(seconds=30)
                ),
                # The sample's tools, served by the Airline MCP server (airline_server.py).
                mcp_server_providers=[StatelessMCPServerProvider("Airline", AirlineServer)],
            ),
        ],
    )

    worker = Worker(
        client,
        task_queue="openai-agents-task-queue",
        workflows=[
            CustomerServiceWorkflow,
        ],
        # G1: the admitted policy (`polyflow policy policy.json > policy.admitted.json`)
        # decides every activity before it is scheduled; the ledger goes to ./ledger.
        plugins=[PolyflowPlugin(level="guard", policy=json.loads(POLICY.with_suffix(".admitted.json").read_text()), sink=FileSink(Path("ledger")))],
    )
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
