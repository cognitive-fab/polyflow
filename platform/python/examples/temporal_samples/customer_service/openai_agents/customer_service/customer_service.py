from __future__ import annotations as _annotations

from typing import Dict, Tuple

from agents import Agent, RunContextWrapper, handoff
from agents.extensions.handoff_prompt import RECOMMENDED_PROMPT_PREFIX
from pydantic import BaseModel
from temporalio import workflow
from temporalio.contrib import openai_agents

### CONTEXT


class AirlineAgentContext(BaseModel):
    passenger_name: str | None = None
    confirmation_number: str | None = None
    seat_number: str | None = None
    flight_number: str | None = None


### TOOLS

# Upstream, `faq_lookup_tool` and `update_seat` are `@function_tool`s that run
# inside the workflow, so a seat change never crosses an activity boundary and
# nothing outside the model can see or refuse it. Here they are tools of the
# "Airline" MCP server (airline_server.py): every call is the activity
# `Airline-stateless-call-tool-v2`, which the worker's Polyflow policy
# classifies by tool name. The agents below are otherwise unchanged.


def airline_tools():
    return openai_agents.workflow.stateless_mcp_server("Airline")


### HOOKS


async def on_seat_booking_handoff(
    context: RunContextWrapper[AirlineAgentContext],
) -> None:
    flight_number = f"FLT-{workflow.random().randint(100, 999)}"
    context.context.flight_number = flight_number


### AGENTS


def init_agents() -> (
    Tuple[Agent[AirlineAgentContext], Dict[str, Agent[AirlineAgentContext]]]
):
    """
    Initialize the agents for the airline customer service workflow.
    :return: triage agent
    """
    faq_agent = Agent[AirlineAgentContext](
        name="FAQ Agent",
        handoff_description="A helpful agent that can answer questions about the airline.",
        instructions=f"""{RECOMMENDED_PROMPT_PREFIX}
        You are an FAQ agent. If you are speaking to a customer, you probably were transferred to from the triage agent.
        Use the following routine to support the customer.
        # Routine
        1. Identify the last question asked by the customer.
        2. Use the faq lookup tool to answer the question. Do not rely on your own knowledge.
        3. If you cannot answer the question, transfer back to the triage agent.""",
        mcp_servers=[airline_tools()],
    )

    seat_booking_agent = Agent[AirlineAgentContext](
        name="Seat Booking Agent",
        handoff_description="A helpful agent that can update a seat on a flight.",
        instructions=f"""{RECOMMENDED_PROMPT_PREFIX}
        You are a seat booking agent. If you are speaking to a customer, you probably were transferred to from the triage agent.
        Use the following routine to support the customer.
        # Routine
        1. Ask for their confirmation number.
        2. Ask the customer what their desired seat number is.
        3. Use the update seat tool to update the seat on the flight.
        If the customer asks a question that is not related to the routine, transfer back to the triage agent. """,
        mcp_servers=[airline_tools()],
    )

    triage_agent = Agent[AirlineAgentContext](
        name="Triage Agent",
        handoff_description="A triage agent that can delegate a customer's request to the appropriate agent.",
        instructions=(
            f"{RECOMMENDED_PROMPT_PREFIX} "
            "You are a helpful triaging agent. You can use your tools to delegate questions to other appropriate agents."
        ),
        handoffs=[
            faq_agent,
            handoff(agent=seat_booking_agent, on_handoff=on_seat_booking_handoff),
        ],
    )

    faq_agent.handoffs.append(triage_agent)
    seat_booking_agent.handoffs.append(triage_agent)
    return triage_agent, {
        agent.name: agent for agent in [faq_agent, seat_booking_agent, triage_agent]
    }


class ProcessUserMessageInput(BaseModel):
    user_input: str
    chat_length: int
