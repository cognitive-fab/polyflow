"""Workflows and activities for tests/test_parity.py: the TypeScript plugin's
behaviours the Python plugin now mirrors (P6-P8 review PY1, PY5, D1).

Kept in their own module: the Temporal sandbox re-imports a workflow's module."""

import asyncio
from datetime import timedelta

from temporalio import activity, workflow

T = timedelta(seconds=10)


@activity.defn
async def lookup(args: dict) -> str:
    return f"found({args['q']})"


@activity.defn
async def slow(_: dict) -> str:
    for _ in range(200):
        activity.heartbeat()
        await asyncio.sleep(0.05)
    return "slow done"


class Refusal(Exception):
    """A plain exception a worker declares a workflow failure."""


@workflow.defn
class ChainAgent:
    """One lookup per execution, then Continue-as-New: the guard's budget is the chain's."""

    @workflow.run
    async def run(self, left: int) -> str:
        try:
            await workflow.execute_activity(lookup, {"q": str(left)}, start_to_close_timeout=T)
        except Exception as err:  # noqa: BLE001
            cause = getattr(err, "cause", None) or err
            return f"denied:{getattr(cause, 'type', '')}"
        if left > 1:
            workflow.continue_as_new(left - 1)
        return "done"


@workflow.defn
class CancelledMidActivity:
    @workflow.run
    async def run(self) -> str:
        return await workflow.execute_activity(slow, {}, start_to_close_timeout=timedelta(seconds=30), heartbeat_timeout=timedelta(seconds=2))


@workflow.defn
class DeclaredFailure:
    @workflow.run
    async def run(self) -> str:
        await workflow.execute_activity(lookup, {"q": "x"}, start_to_close_timeout=T)
        raise Refusal("the agent gave up")


@workflow.defn
class Signaller:
    @workflow.run
    async def run(self, target: str) -> str:
        await workflow.execute_activity(lookup, {"q": "x"}, start_to_close_timeout=T)
        try:
            await workflow.get_external_workflow_handle(target).signal("poke", "now")
        except Exception as err:  # noqa: BLE001
            return f"denied:{getattr(err, 'type', '')}"
        return "signalled"


@workflow.defn
class Sleeper:
    def __init__(self):
        self.poked = False

    @workflow.run
    async def run(self) -> str:
        await workflow.wait_condition(lambda: self.poked)
        return "poked"

    @workflow.signal
    def poke(self, _: str) -> None:
        self.poked = True

