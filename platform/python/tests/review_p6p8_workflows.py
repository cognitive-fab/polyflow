"""Workflows and activities for tests/test_review_p6p8.py (the P6-P8 review).

Kept in their own module for the same reason as agent_workflows.py: the
Temporal sandbox re-imports a workflow's module."""

from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.exceptions import ApplicationError


@dataclass
class Usage:
    usd: float


@activity.defn
async def leaky_tool(_: dict) -> str:
    # An upstream error that echoes a credential back, as real APIs do.
    raise ApplicationError("upstream rejected the call: api_key=sk-live-0123456789abcdefghij", non_retryable=True)


@activity.defn
async def llm(_: dict) -> Usage:
    # Python activities return dataclasses / pydantic models far more often than dicts.
    return Usage(usd=5.0)


@activity.defn
async def search(args: dict) -> str:
    return f"found({args['q']})"


T = timedelta(seconds=10)


@workflow.defn
class LeakyAgent:
    @workflow.run
    async def run(self) -> str:
        try:
            await workflow.execute_activity(leaky_tool, {}, start_to_close_timeout=T)
        except Exception:  # noqa: BLE001
            return "tool failed"
        return "ok"


@workflow.defn
class SpendingAgent:
    @workflow.run
    async def run(self) -> list:
        out = []
        for _ in range(2):
            try:
                u = await workflow.execute_activity(llm, {}, start_to_close_timeout=T)
                out.append(f"spent {u.usd}")
            except Exception as err:  # noqa: BLE001
                cause = getattr(err, "cause", None) or err
                out.append(f"denied:{getattr(cause, 'type', '')}")
        return out


@workflow.defn
class Courier:
    """A child workflow that does the thing the parent's policy does not allow."""

    @workflow.run
    async def run(self) -> str:
        return "delivered"


@workflow.defn
class DelegatingAgent:
    @workflow.run
    async def run(self) -> str:
        await workflow.execute_activity(search, {"q": "x"}, start_to_close_timeout=T)
        try:
            return await workflow.execute_child_workflow(Courier.run, id=f"{workflow.info().workflow_id}-courier")
        except Exception as err:  # noqa: BLE001
            return f"denied:{err}"


@workflow.defn
class WaitingAgent:
    @workflow.run
    async def run(self) -> str:
        await workflow.execute_activity(search, {"q": "x"}, start_to_close_timeout=T)
        await workflow.wait_condition(lambda: False)
        return "never"
