Another Opus 5 project: polyflow, a workflow engine for AI agents. Polygraph audits, polygen authors, polyrun executes, polyvers evolves — polyflow puts an agent on top of them.

The problem shows up the moment an agent stops being a chat window. An agent decides one tool call at a time, and the plan behind those calls lives in the conversation. When the conversation ends, the plan is gone. Nothing is left that knows what was already done.

I tested that against OpenWorker, Andrew Ng's open-source desktop agent, unmodified. The task: gather yesterday's support tickets, draft a customer brief, get a human to approve it, post it to a Slack channel. Then let the scheduler fire the same job a second time on the same day — which is what OpenWorker already does for jobs missed while the machine was off.

48 runs, DeepSeek V4 Flash, 8 per condition:

- Without polyflow, the second run posted the brief to Slack again. 8 times out of 8. It had no way to know the first run had happened.
- With polyflow, 0 out of 8. The second run asked for the workflow by name, saw it had finished, and stopped.
- Every run in every condition waited for human approval before posting — with polyflow and without it. On a single clean run, the engine changes nothing about safety. It is the second run that separates them.

What polyflow does:

1. A task is described once as a state machine: the steps, the order they can happen in, and which tool performs each one.
2. polyflow hands the agent one work order at a time — call this tool, with these arguments. The agent makes the call itself, with its own credentials and its own approval prompts. polyflow has neither.
3. The agent reports the result. polyflow commits the new state and hands back the next order.
4. Before any of that, it walks every path the machine can take and checks the rules the workflow declares. "No Slack post on any path without a prior approval" is one of them. A workflow that breaks a rule is not loaded — it cannot be started at all.

The part I did not expect to matter as much as it does: the workflow is not something the agent remembers. It is not compacted, summarized, or retrieved into a prompt. It sits in a database and the agent queries it. The second session in that test did not recall that the brief had been posted. It asked, and was told.

A literature pass says the ingredients exist separately:

- Procedural memory for agents — Voyager's skill library, Agent Workflow Memory, Memp, WorkflowGen, CodeMem. The agent induces reusable procedures from past runs. None of them check a procedure before reusing it.
- Durable execution — Temporal, LangGraph, Step Functions. State survives a restart and the procedure constrains the run, but a developer wrote that procedure ahead of time and nothing checked it against a stated rule.

What I could not find published: a procedure the agent can run, stored outside its context window, that is admitted only after every path through it has been checked.

polyflow ships as an MCP server, so it attaches to any agent that speaks MCP — OpenWorker, Kiro Crew, Claude Code, the NeMo Agent Toolkit. AWS Agent Registry, which landed this week, is the other half of the same picture: a curator there approves that a server may be found, while polyflow decides that a workflow may run.

The usual disclosure applies: these are consistency checks, not proofs; "exhaustive" means exhaustive over the finite action and data domains you declare; and the checks are only as good as the rules you write. One model, one task, 8 runs per condition — enough to say 8 of 8 against 0 of 8 is not chance, and nothing more than that. The workflows in the repo were written by hand; having the agent derive them from its own past runs is the next piece and is not built.

Repo, the test harness, and all 48 run records in the comments.

#AIAgents #MCP #StateMachines #DurableExecution #FormalVerification
