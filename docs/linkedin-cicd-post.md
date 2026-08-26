# LinkedIn — agent-driven CI/CD

My CI refuses to deploy the backend, deliberately: the role it holds is frontend-only, and a full build on a shared runner costs more than it is worth. It prints the command and tells me to run it from a workstation. So I run it from an agent.

Every gate the automated path has then disappears. No check that the commit is on main. No suite re-run at that commit. No enforced smoke test. No tag. No record. The riskiest deploy path in the project is the only one with nothing watching it.

That is what bothers me about loop engineering, and it is not that the agent misbehaves. It usually doesn't. It is that nothing in the system can tell you whether it did.

In a loop the sequence exists as intentions in a transcript. The ancestry check happened before the deploy — probably. The approval came first — I think so. Nothing records the ordering as a fact, nothing checks it, and by the time a session is long enough to matter the early turns have been compacted into a summary. You are not trusting the model's judgment. You are trusting your memory of a conversation.

So I wrote the deploy as a state machine that hands the agent one instruction at a time. The agent runs every command itself, with its own credentials and prompts. The engine has neither. It decides what comes next, records what happened, and refuses anything out of order.

Then the rules, checked over every reachable path before the workflow can load — seven paths, fourteen states:

- no production deploy without an ancestry check
- no deploy without the suite passing at that commit
- no deploy without an approval — the gate the hosted plan sells only on a paid tier
- at most one deploy per path, which is also at most one CDN invalidation
- no tag without a passing smoke check: a tag is the rollback target
- a smoke check implies a prior deploy, so a green result cannot describe the previously live build

None are inventions. All were already in the project's CI docs, in prose, describing the automated path. Writing them as a workflow only made them apply to the path that was never covered.

Then the checker refused my workflow.

I had written an eighth rule: exactly one test run per promotion. It sounded right. The gate walked the paths and handed back the one that broke it — a promotion failing the ancestry check never reaches the suite, and shouldn't. The rule was wrong, not the machine. It became at most one.

That is the argument in one incident. I would have shipped that rule. A reviewer would have nodded at it.

Disclosure: a consistency check, not a proof; exhaustive over the values the workflow declares. It does not test your code, and it constrains the run, not the agent.

What I did not expect to value most is the journal: every step of every deploy, accepted or rejected, with reasons. Being able to answer who approved which commit going to production, and whether the smoke check passed before it was tagged, is worth the afternoon on its own.

Repo and the write-up with diagrams in the comments.

#AIAgents #CICD #StateMachines #DevOps #FormalVerification
