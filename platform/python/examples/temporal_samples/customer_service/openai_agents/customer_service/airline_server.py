"""The "Airline" MCP server: the sample's two tools, moved out of the workflow,
plus the booking record they act on.

Upstream, ``update_seat`` writes the new seat into the agent's run context and
asserts that the seat-booking handoff has set a flight number. Out here the
booking is a record on the server, so the natural equivalent of that assertion
is a lookup: ``get_booking`` reads the record (the flight number included) and
``update_seat`` changes it. The policy makes that order a rule (a seat change
requires a prior read), which the model cannot skip.

``cancel_booking`` exists and is deliberately NOT declared in the policy: a
routed tool the policy does not name is always refused (reference manual 2.1).

The server is stateless and in-process so the sample runs offline; the
Temporal integration treats it as it would a real stdio or HTTP server: every
call is the activity ``Airline-stateless-call-tool-v2`` carrying the tool name.
"""

from __future__ import annotations

import json
from typing import Any

from agents.mcp import MCPServer
from mcp.types import CallToolResult, GetPromptResult, ListPromptsResult, TextContent, Tool

BOOKINGS: dict[str, dict] = {
    "ABC123": {"confirmation_number": "ABC123", "passenger_name": "Ada Lovelace", "flight_number": "FLT-512", "seat_number": "9C"},
}

# Seat changes this process has made, so a test can see what really happened.
SEAT_CHANGES: list[dict] = []


def faq_lookup(question: str) -> str:
    """Byte for byte the body of upstream's ``faq_lookup_tool``."""
    question_lower = question.lower()
    if "bag" in question_lower or "baggage" in question_lower:
        return (
            "You are allowed to bring one bag on the plane. "
            "It must be under 50 pounds and 22 inches x 14 inches x 9 inches."
        )
    elif "seats" in question_lower or "plane" in question_lower:
        return (
            "There are 120 seats on the plane. "
            "There are 22 business class seats and 98 economy seats. "
            "Exit rows are rows 4 and 16. "
            "Rows 5-8 are Economy Plus, with extra legroom. "
        )
    elif "wifi" in question_lower:
        return "We have free wifi on the plane, join Airline-Wifi"
    return "I'm sorry, I don't know the answer to that question."


class AirlineServer(MCPServer):
    def __init__(self) -> None:
        super().__init__()

    @property
    def name(self) -> str:
        return "Airline"

    async def connect(self) -> None:
        pass

    async def cleanup(self) -> None:
        pass

    async def list_tools(self, run_context=None, agent=None) -> list[Tool]:
        by_confirmation = {"type": "object", "properties": {"confirmation_number": {"type": "string"}}, "required": ["confirmation_number"]}
        seat = {"type": "object", "properties": {"confirmation_number": {"type": "string"}, "new_seat": {"type": "string"}},
                "required": ["confirmation_number", "new_seat"]}
        question = {"type": "object", "properties": {"question": {"type": "string"}}, "required": ["question"]}
        return [
            Tool(name="faq_lookup_tool", description="Lookup frequently asked questions.", inputSchema=question),
            Tool(name="get_booking", description="Read a booking by its confirmation number.", inputSchema=by_confirmation),
            Tool(name="update_seat", description="Update the seat for a given confirmation number.", inputSchema=seat),
            Tool(name="cancel_booking", description="Cancel a booking. Irreversible.", inputSchema=by_confirmation),
        ]

    async def call_tool(self, tool_name: str, arguments: dict[str, Any] | None, meta: dict[str, Any] | None = None) -> CallToolResult:
        args = arguments or {}
        if tool_name == "faq_lookup_tool":
            text = faq_lookup(str(args.get("question", "")))
        elif tool_name == "get_booking":
            text = json.dumps(BOOKINGS.get(args.get("confirmation_number"), {"error": "no such booking"}))
        elif tool_name == "update_seat":
            booking = BOOKINGS.get(args.get("confirmation_number"))
            if booking is None:
                return CallToolResult(content=[TextContent(type="text", text="no such booking")], isError=True)
            booking["seat_number"] = args.get("new_seat")
            SEAT_CHANGES.append({"confirmation_number": booking["confirmation_number"], "new_seat": booking["seat_number"]})
            text = f"Updated seat to {booking['seat_number']} for confirmation number {booking['confirmation_number']}"
        elif tool_name == "cancel_booking":
            BOOKINGS.pop(args.get("confirmation_number"), None)
            text = "cancelled"
        else:
            return CallToolResult(content=[TextContent(type="text", text=f"unknown tool {tool_name}")], isError=True)
        return CallToolResult(content=[TextContent(type="text", text=text)])

    async def list_prompts(self) -> ListPromptsResult:
        return ListPromptsResult(prompts=[])

    async def get_prompt(self, name: str, arguments: dict[str, Any] | None = None) -> GetPromptResult:
        raise ValueError("no prompts")
