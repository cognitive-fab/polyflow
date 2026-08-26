# X thread — Hermes memory and polyflow

Tag: @NousResearch

---

**1/**

@NousResearch Hermes skills are procedural memory the agent writes for itself — markdown under ~/.hermes/skills, pulled in on demand, optionally staged for human approval before they're kept.

That solves "the agent learns a procedure."

What it leaves open: what the procedure is allowed to do.

**2/**

polyflow is the other half. A workflow is a state machine plus rules like "no Slack post on any path without a prior approval."

Every path is checked before it loads. Break a rule and the workflow isn't registered — not flagged, unrunnable.

**3/**

Measured on a scheduled job that ends in a public Slack post, fired twice in one day. 48 runs, DeepSeek V4 Flash:

no engine → posted twice, 8 of 8
polyflow → posted once, 8 of 8

The second session didn't recall the brief was already posted. It asked.

**4/**

That's the split from memory: the procedure never enters the context window. Nothing to summarize, nothing to compact. The agent queries it.

Same reason it doesn't fight Tool Search or the debloat pass — polyflow is six tools total, and the workflow itself is never in context.

**5/**

They compose. The skill carries when to reach for it; polyflow carries what it may do once you have.

It's an MCP server, so it's one entry under mcp_servers in config.yaml.

Apache-2.0 → github.com/cognitive-fab/polyflow

---

## Single-post alternative

@NousResearch Hermes skills solve "the agent learns a procedure." polyflow does the next bit: the procedure is a state machine checked on every path before it loads, and its state lives outside the context window.

Scheduled job fired twice in a day, 48 runs: without it, posted to Slack twice in 8 of 8. With it, once in 8 of 8. The second session didn't remember — it asked.

MCP, Apache-2.0 → github.com/cognitive-fab/polyflow
