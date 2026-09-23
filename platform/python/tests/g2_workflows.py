"""A workflow that steps a certified machine through the QuickJS host (G2 from
Python, plan P7.4). Kept in its own module: the sandbox re-imports it. The host
is built at worker start-up and reached by name through polyflow_temporal
(a passthrough module), so the workflow reads no file."""

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from polyflow_temporal.machine_host import machine


@workflow.defn
class MachineRun:
    @workflow.run
    async def run(self, name: str, script: list) -> list:
        host = machine(name)
        state = host.init()
        trail = []
        info = workflow.info()
        for seq, (action, data) in enumerate(script, start=1):
            r = host.step(state, action, data, run_key=f"{info.workflow_id}/{info.run_id}", seq=seq, now=int(workflow.time() * 1000))
            state = r["post"]
            trail.append({"stepKind": r["stepKind"], "state": state, "intents": [e["intentId"] for e in r["effects"]]})
        return trail
