Another Opus 5 project: polycrew — several Claude Code sessions working one job at the same time.

If you already keep two or three sessions open on one repository, you have had this problem. Both see the same work. Nothing stops both doing it. Two agents editing the same file, or two runs of a job that was meant to happen once. The usual fix is a supervisor that hands out assignments — one more service to run, and one more thing to be wrong.

polycrew has no supervisor. Agents never talk to each other; they talk to the run.

Claude Code now lets sessions message each other directly, which is a useful and different thing. A message has to be sent, received and acted on, and two sessions that both forget to send one still collide. A claim is not a message: an agent that takes an order changes what every other agent is offered, without telling anyone anything. Sessions end up talking only when the work actually requires it.

How it works:

1. A job is a state machine, and it is checked before it loads. A workflow whose rules can be broken on any reachable path is not registered — it cannot be started at all.
2. Work becomes orders. An agent asks what is free, claims one, does it with its own tools and its own permissions, and reports the result.
3. A claim is a lease. Only the holder may report. Silence past the lease returns the order to the queue, so a session that dies mid-task loses its work rather than blocking it.
4. A run's identity is derived from its input. Two agents starting "the same job" get one run, because neither is in a position to name a second one.
5. Whichever session starts first binds a port and becomes the broker for the rest. Binding the port is the election. No consensus protocol, nothing to install, nothing to configure.

Two real Claude Code sessions, started together on one crew: both called workflow_start, and there is one run. Four work orders, four completions, no duplicates. Two identities neither session chose, because no tool schema has a field for an actor. Both reached for an order the other already had, and both went and found different work — a refused claim answers "claimed: false" with the holder rather than raising an error, because a model retries an error and redirects on an answer.

There is a page, too. Loopback, read-only, on the port the broker already holds: what needs a person, and what is running — who holds each order, and what the machine is waiting for.

One example ships with it: a codemod sweep across a monorepo, run by headless agents. One run per file rather than one run holding fifty orders — so every outstanding file is on offer at once, any number of agents can drain the queue, and re-running tomorrow re-attaches instead of starting a second sweep. No file is edited twice. That is not an instruction in the worker prompt; it is a rule the workflow was admitted under, so a second edit order for one file is something the engine will not emit.

This is an MVP, not a commercial-grade product. There is no authentication: loopback is the security model, and reaching a crew from another machine means an SSH tunnel. The checks are consistency checks, not proofs — "exhaustive" means exhaustive over the finite domain a workflow declares, and they are only as good as the rules you write. It has been exercised at the scale of a few agents and a handful of orders, not a fleet.

polycrew is the multi-participant layer over polyflow, which stays the single-agent engine — one process, stdio, SQLite, nothing to install. If you only ever run one agent, you do not need this.

Repo and the sweep example in the comments.

#AIAgents #MCP #ClaudeCode #StateMachines #MultiAgent
