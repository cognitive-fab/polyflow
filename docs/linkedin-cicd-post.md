# LinkedIn — agent-driven CI/CD

I deploy a production web app from an agent. Not by choice: my CI refuses backend deploys, because the deploy role it holds is frontend-only. It prints the command and tells me to run it from a workstation.

A deploy run this way has no gates. Nothing checks the commit is on main. Nothing re-runs the suite at that commit. Nothing enforces the smoke test, writes the tag, or keeps a record. The most dangerous path in the project is the only unguarded one.

That is the general problem with agentic loops. The order of steps exists only as intentions in a transcript. Nothing records that order as a fact, nothing checks it, and long sessions get compacted into a summary. You end up trusting your memory of a conversation.

So I write the deploy as a state machine. It hands the agent one instruction at a time. The agent runs each command itself, with its own credentials and prompts; the engine has none. The engine decides the order, records every result, and refuses anything out of sequence.

Its rules are checked over every reachable path before the workflow loads — seven paths, fourteen states:

- no production deploy without an ancestry check
- no deploy without the suite passing at that commit
- no deploy without an approval, the gate my hosted plan sells only on a paid tier
- at most one deploy per path, which is also at most one CDN invalidation
- no tag without a passing smoke check, because a tag is the rollback target
- no smoke check before a deploy, so a green result cannot describe the old build

I invented none of them. Every one was already in my CI documentation, written as prose about the automated path. Turning them into a workflow made them apply to the path nothing covered.

Then the checker refused my workflow.

I had written an eighth rule: exactly one test run per promotion. The checker walked the paths and returned the one that broke it. A promotion failing the ancestry check never reaches the suite, and should not. The rule was wrong, not the machine. It became at most one.

I would have shipped that rule. A reviewer would have nodded at it.

Disclosure: a consistency check, not a proof, exhaustive only over the values the workflow declares. It does not test my code, and it constrains the run, not the agent.

The part I underrated is the journal: every step of every deploy, accepted or rejected, with reasons. I can now answer who approved which commit for production, and whether the smoke check passed before the tag was written.

Repo and a write-up with diagrams in the comments.

#AIAgents #CICD #StateMachines #DevOps
