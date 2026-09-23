"""Polyflow for LangGraph — a second engine binding at G0 (observe) and G1 (guard).

The same kernel as the Temporal plugin (canonical JSON, the hash-chained
ledger, the rule kernel), imported from ``polyflow_temporal``'s engine-neutral
modules: this package never imports ``temporalio``. A ledger written here
verifies under the TypeScript ``polyflow verify``, and the guard decides a tool
call exactly as it decides an activity on Temporal (plan P10).

    from polyflow_langgraph import govern
    tools = govern([read_ticket, issue_refund], level="guard", policy=admitted, sink=FileSink("./ledger"))
    agent = create_react_agent(model, tools, checkpointer=saver)   # the agent's code is unchanged
    ...
    tools.governor.close(agent, config)                             # optional: the final closure

See docs/platform/research/06-second-engine-langgraph.md for what is bound, what
differs from Temporal and what LangGraph does not guarantee.
"""

from .binding import (
    META_KEY,
    Governor,
    checkpoint_ms,
    close,
    govern,
    govern_effect,
    ledger_of,
    observe_effect,
)

__all__ = [
    "META_KEY",
    "Governor",
    "checkpoint_ms",
    "close",
    "govern",
    "govern_effect",
    "ledger_of",
    "observe_effect",
]
