"""A stateless, in-process MCP server with two tools: ``read_ticket`` and
``issue_refund``. It stands in for a real ticketing MCP server (stdio or HTTP),
so the sample runs offline; the Temporal integration treats it exactly as it
would a real one: every call is the activity ``Tickets-stateless-call-tool-v2``
with the tool name inside its dataclass argument.
"""

from __future__ import annotations

import json
from typing import Any

from agents.mcp import MCPServer
from mcp.types import CallToolResult, GetPromptResult, ListPromptsResult, TextContent, Tool

TICKETS = {"T-1": {"id": "T-1", "customer": "ada@example.com", "order": 1234, "amount": 40.0, "reason": "damaged on arrival"}}

# Refunds this process has issued, so a test can see what really happened.
REFUNDS: list[dict] = []


class TicketsServer(MCPServer):
    def __init__(self) -> None:
        super().__init__()

    @property
    def name(self) -> str:
        return "Tickets"

    async def connect(self) -> None:
        pass

    async def cleanup(self) -> None:
        pass

    async def list_tools(self, run_context=None, agent=None) -> list[Tool]:
        ticket_id = {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}
        refund = {"type": "object", "properties": {"id": {"type": "string"}, "amount": {"type": "number"}}, "required": ["id", "amount"]}
        return [
            Tool(name="read_ticket", description="Read a support ticket.", inputSchema=ticket_id),
            Tool(name="issue_refund", description="Refund the customer. Irreversible.", inputSchema=refund),
        ]

    async def call_tool(self, tool_name: str, arguments: dict[str, Any] | None, meta: dict[str, Any] | None = None) -> CallToolResult:
        args = arguments or {}
        if tool_name == "read_ticket":
            text = json.dumps(TICKETS.get(args.get("id"), {"error": "no such ticket"}))
        elif tool_name == "issue_refund":
            REFUNDS.append({"id": args.get("id"), "amount": args.get("amount")})
            text = json.dumps({"refunded": args.get("amount"), "ticket": args.get("id")})
        else:
            return CallToolResult(content=[TextContent(type="text", text=f"unknown tool {tool_name}")], isError=True)
        return CallToolResult(content=[TextContent(type="text", text=text)])

    async def list_prompts(self) -> ListPromptsResult:
        return ListPromptsResult(prompts=[])

    async def get_prompt(self, name: str, arguments: dict[str, Any] | None = None) -> GetPromptResult:
        raise ValueError("no prompts")
