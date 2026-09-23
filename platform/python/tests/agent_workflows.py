"""Workflows and activities for the plugin tests, in their own module: the
Temporal sandbox re-imports a workflow's module, so it must stay free of
file-system and path work."""

from datetime import timedelta

from temporalio import activity, workflow


@activity.defn
async def ask_approval(_: dict) -> str:
    return "yes"


@activity.defn
async def slack_send(args: dict) -> str:
    return f"posted:{args['text']}"


@activity.defn
async def search(args: dict) -> str:
    return f"found({args['q']})"


@workflow.defn
class AgentLoop:
    """An ordinary agent loop, written the way a Temporal Python customer writes one."""

    @workflow.run
    async def run(self, ask_first: bool) -> list:
        trail = []
        t = timedelta(seconds=10)
        trail.append(await workflow.execute_activity(search, {"q": "tickets"}, start_to_close_timeout=t))
        if ask_first:
            trail.append(await workflow.execute_activity(ask_approval, {}, start_to_close_timeout=t))
        try:
            trail.append(await workflow.execute_activity(slack_send, {"text": "brief"}, start_to_close_timeout=t))
        except Exception as err:  # the agent reads the refusal like any tool error
            cause = getattr(err, "cause", None) or err
            trail.append(f"denied:{getattr(cause, 'type', '')}:{getattr(cause, 'message', cause)}")
        return trail


