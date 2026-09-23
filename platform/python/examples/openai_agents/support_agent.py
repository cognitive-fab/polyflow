"""The agent, exactly as an OpenAI Agents SDK user writes it on Temporal.

Nothing here knows about Polyflow: no import, no wrapper, no decorator. The
governance is one line on the worker (``PolyflowPlugin(level="guard", ...)``,
see run.py). Kept in its own module because the Temporal sandbox re-imports a
workflow's module.
"""

from agents import Agent, Runner
from temporalio import workflow
from temporalio.contrib import openai_agents


@workflow.defn
class SupportAgent:
    @workflow.run
    async def run(self, request: str) -> str:
        tickets = openai_agents.workflow.stateless_mcp_server("Tickets")
        agent = Agent(
            name="Support",
            instructions="Resolve the customer's request with the ticket tools.",
            mcp_servers=[tickets],
        )
        result = await Runner.run(agent, input=request)
        return result.final_output
