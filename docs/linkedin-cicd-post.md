# LinkedIn — agent-driven CI/CD

A while back I took Adron Hall's "loops are a broken SDLC" argument literally and rebuilt a document pipeline as a checked state machine instead of an agentic loop. This week I pointed the same idea at something that actually scares me: deploying to production.

My CI refuses to deploy the backend, deliberately. The role it holds is frontend-only, and a full backend build on a shared runner costs more than it is worth. So it prints the command and tells me to run it from a workstation. Which means I run it from an agent.

At that moment every gate the automated path has simply disappears. No check that the commit is on main. No re-run of the suite at that exact commit. No enforced smoke test. No tag. No record. The riskiest deploy path in the project is the only one with nothing watching it.

This is the part of loop engineering that bothers me most, and it is not that the agent misbehaves. It usually doesn't. It is that **nothing in the system can tell you whether it did.**

In a loop, the sequence exists as intentions in a transcript. The ancestry check happened before the deploy — probably. The approval came first — I think so. Nothing records the ordering as a fact, nothing checks it, and by the time a session is long enough to matter, the early turns have been compacted into a summary. Every one of those steps happened under the rug. You are not trusting the model's judgment; you are trusting your memory of a conversation.

So I wrote the deploy as a workflow instead: a small state machine that hands the agent one instruction at a time. The agent runs every command itself, with its own credentials and its own approval prompts — the engine has neither. It decides what comes next, records what happened, and refuses anything out of order.

Then the rules, checked over every reachable path before the workflow can load. Seven paths, fourteen states:

1. No production deploy without an ancestry check.
2. No production deploy without the suite passing at that commit.
3. No production deploy without an approval — the gate the hosted plan sells only on a paid tier.
4. At most one production deploy per path. The deploy script ends with a CDN invalidation, so that is also at most one invalidation.
5. No tag without a passing smoke check. A tag is the rollback target; it must never point at a deploy that failed on the way out.
6. At most one tag per path.
7. A smoke check implies a prior deploy, so a green result can never describe the previously live build.

None of these are inventions. Every one was already written in the project's own CI documentation, in prose, describing what the automated path does. Moving them into a workflow only made them apply to the path that was never covered.

Then the checker refused my workflow.

I had written an eighth rule: *exactly one test run per promotion*. It sounded right. The gate walked the paths and handed back the one that broke it — a promotion that fails the ancestry check never reaches the suite, and shouldn't. The rule was wrong, not the machine. It became *at most one*, plus a new rule that tests imply a prior ancestry check.

That is the whole argument in one incident. I would have shipped that rule. A reviewer reading it would have nodded. Enumerating the paths is what turned a plausible sentence into a refused workflow.

The usual disclosure: this is a consistency check, not a proof, and "exhaustive" means exhaustive over the values the workflow declares. It does not test your code — a compliant workflow can still ship something broken. It constrains the run, not the agent: if the agent runs the deploy command outside the workflow, nothing stops it.

What I did not expect to value most is the journal. Every step of every deploy, accepted or rejected, with reasons. A workstation deploy has never had that. Even with the gates set aside, being able to answer *who approved which commit going to production, and did the smoke check pass before it was tagged* is worth the afternoon.

Repo and the write-up with diagrams in the comments.

#AIAgents #CICD #StateMachines #DevOps #FormalVerification
