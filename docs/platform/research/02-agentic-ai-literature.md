# Durable, Governed Agentic AI: A Literature Review

*Research note 02 for the platform. Compiled 2026-09-22. Scope: academic and practitioner work, weighted toward 2024-2026.*

## Framing

The platform thesis is: **bring some degree of determinism without disrupting what makes AI agents smart.** The LLM decides *how* to fulfil a step; a verified state machine (SAM pattern, model-checked invariants) decides *what may happen next*. This review asks what the literature says about that split. Where does it help? Where has someone already built part of it? Where does it break down?

Each section gives the main findings with citations, then a paragraph headed **Implication for the platform**. The review ends with a ranked list of requirements that the evidence supports.

A note on sources: many 2026 items are arXiv preprints that have not been peer reviewed yet. They are cited as signals of where the field is going, not as settled results. Numbers are the authors' own.

---

## 1. Why agents fail in production

### 1.1 Failure taxonomies

**MAST (Multi-Agent System Failure Taxonomy).** Cemri, Pan, Yang et al. analysed 150 traces with expert annotators (Cohen's κ = 0.88) and found 14 failure modes in three clusters: *system design issues*, *inter-agent misalignment*, and *task verification*. They then released MAST-Data, 1,600+ annotated traces from 7 frameworks (NeurIPS 2025; [arXiv:2503.13657](https://arxiv.org/abs/2503.13657)). Secondary analyses of MAST-Data report these as the most common modes: step repetition (~17%), reasoning-action mismatch (~14%), where the agent reasons correctly and then acts differently, and failure to ask for clarification (~12%) ([summary](https://agentswarms.fyi/blog/why-do-multi-agent-llm-systems-fail)). The authors' main conclusion is that many failures come from *system design*, not model capability. Termination conditions, role specs and verification steps are missing, and a better model does not fix that.

**Silent and "fail-plausible" failures.** Wu followed a production personal-assistant runtime (about 40 scheduled jobs, 8 LLM providers) for eight weeks and recorded 22 incidents. About 70% of silent failures were caught by humans noticing, not by tests. The paper names a failure class specific to LLMs: *fail-plausible*, where the system turns an error into a fluent, plausible narrative for the user. The longest-lived failures sat "in the seams between components, where no test runs" ([arXiv:2606.14589](https://arxiv.org/abs/2606.14589)). Advani studied about 12,000 trajectories and found that **false success**, where the agent claims completion wrongly, accounts for 45-48% of failures in single-control τ²-bench domains and 75.8% of self-assessing AppWorld coding trajectories ([arXiv:2606.09863](https://arxiv.org/abs/2606.09863)).

**Coding agents.** An ICSE 2026 study of OpenHands, SWE-agent and Prometheus trajectories on SWE-bench found that failed trajectories are consistently *longer and higher-variance* than successful ones. Agents locate the right file 72-81% of the time even when they fail, so failure comes from fine-grained reasoning and implementation, not from search ([arXiv:2511.00197](https://arxiv.org/abs/2511.00197)). Separately, patches that pass SWE-bench tests are often not actually correct ([arXiv:2503.15223](https://arxiv.org/abs/2503.15223)), and AgentLens calls this the "lucky pass" problem ([arXiv:2605.12925](https://arxiv.org/abs/2605.12925)). Outcome-only scoring overstates reliability.

**Sequence-level signatures.** Deng encodes 347 production traces as sequences over {Explore, Execute, Plan, Verify}. Only one trigram, Plan-Execute-Plan, is a statistically significant risk marker (−10.4% success). The Execute→Verify transition probability is only 2.1%, which the author calls a "systemic verification deficit." A runtime "Governor" built on these patterns raised success by 6.2 points and cut tokens by 44% ([arXiv:2606.15579](https://arxiv.org/abs/2606.15579)).

### 1.2 Reliability under repetition: pass^k

τ-bench introduced **pass^k**, the probability that *all* k independent trials succeed, as a reliability metric for tool-agent-user interaction. It showed that even strong function-calling agents drop sharply as k grows ([arXiv:2406.12045](https://arxiv.org/abs/2406.12045)). τ²-bench adds a *dual-control* telecom domain, modelled as a Dec-POMDP, where the user also acts on shared state. It confirms that pass@k rises with k while pass^k "frequently suffers a severe decline" ([arXiv:2506.07982](https://arxiv.org/abs/2506.07982)). For enterprise use, pass^k is the number that matters: a process that runs 10,000 times a month needs *consistency*, not a best case.

### 1.3 Compounding error and long-horizon degradation

Sinha, Arun and Goel (ICLR 2026) separate *execution* from planning and knowledge. Small gains in per-step accuracy compound into exponential gains in the task length a model can finish. They also find a **self-conditioning** effect: models make more mistakes once their own earlier errors are in context, and scale alone does not remove it. Thinking models largely avoid it ([arXiv:2509.09677](https://arxiv.org/abs/2509.09677)). METR's time-horizon work gives the macro trend: the length of tasks agents complete at 50% reliability has been doubling roughly every seven months ([arXiv:2503.14499](https://arxiv.org/abs/2503.14499)). At higher reliability thresholds, the horizon is much shorter. AgentProp-Bench (14,750 traces, 13 agents) finds that a parameter-level error propagates to a wrong final answer with probability ≈0.62 ([arXiv:2604.16706](https://arxiv.org/abs/2604.16706)). Laban et al. show a 39% average performance drop when the same task is spread across a multi-turn conversation instead of stated in one turn: "LLMs get lost in multi-turn conversation" ([arXiv:2505.06120](https://arxiv.org/abs/2505.06120)).

### 1.4 Context rot and compaction

Chroma tested 18 frontier models. Performance fell as input length grew, even when all the relevant information was present ([Chroma, "Context Rot", 2025](https://research.trychroma.com/context-rot)). This extends the earlier "lost in the middle" result ([arXiv:2307.03172](https://arxiv.org/abs/2307.03172)). Anthropic's guidance treats context as a finite "attention budget." It recommends compaction, structured note-taking and sub-agent isolation ([Anthropic, "Effective context engineering for AI agents", 2025](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Compaction has its own failure mode: the summariser does not know what the agent will need later. **Slipstream** runs compaction in parallel with continued execution and has a judge check that the summary keeps "the agent's forward intent and the key facts and constraints it depends on." It improved accuracy by up to 8.8 points on SWE-bench Verified and BrowseComp ([arXiv:2605.08580](https://arxiv.org/abs/2605.08580)). ACE (ICLR 2026) names two related problems: *brevity bias* and *context collapse*, where iterative rewriting wears away detail ([arXiv:2510.04618](https://arxiv.org/abs/2510.04618)).

Practitioner signal: Gartner predicts that over 40% of agentic AI projects will be cancelled by end-2027, citing cost, unclear value and "inadequate risk controls" ([Gartner, June 2025](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)).

**Implication for the platform.** The failure literature supports the thesis directly. The dominant failures are *procedural and structural*: repetition, premature termination, reasoning-action mismatch, false success, lost constraints. They are not failures of raw intelligence. A state machine that owns control flow, termination and "what counts as done" addresses the MAST *system design* and *task verification* clusters structurally. Three design points follow. (a) **Constraints must live outside the context window.** Invariants held in the SAM model survive compaction by construction, while constraints held in the prompt degrade (context rot, compaction loss, self-conditioning). (b) **Completion must be a state-machine fact, not an LLM claim.** False success is the single largest failure class in several domains. (c) **pass^k should be the platform's headline reliability metric**, and the platform should be able to *measure* it by re-running steps from recorded state (see §2). Short, bounded LLM steps with a fresh, state-derived context also reduce self-conditioning. Each step starts from a projection of the verified state, not from a long transcript of the agent's own mistakes.

---

## 2. Determinism and reproducibility

### 2.1 Inference is not deterministic, even at temperature 0

Atil et al. documented large output variation at "deterministic" settings across providers ([arXiv:2408.04667](https://arxiv.org/abs/2408.04667)). Thinking Machines Lab traced the main cause in serving to a **lack of batch invariance**. Kernels such as matmul, RMSNorm and attention change their numerical reduction order with batch size, and batch size depends on server load. With batch-invariant kernels, 1,000 runs of Qwen3-8B under vLLM gave 1,000 identical outputs ([He et al., "Defeating Nondeterminism in LLM Inference", 2025](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/)). Reasoning models make this worse: precision and hardware changes can shift reasoning-model accuracy by several points ([arXiv:2506.09501](https://arxiv.org/abs/2506.09501)). **LLM-42** takes a scheduling approach: a nondeterministic fast path plus a verify-and-rollback loop that replays candidate tokens under fixed-shape reductions. Overhead is paid only by traffic that needs determinism ([arXiv:2601.17768](https://arxiv.org/abs/2601.17768)). Bitwise determinism is achievable in self-hosted serving at some cost. It is **not** something a platform can assume from third-party APIs.

### 2.2 Replay changes what it means once the model changes

Several 2026 papers treat event sourcing as the right substrate for agents and identify its limits. Nakajima's **ActiveGraph** ("The Log is the Agent") makes the append-only event log the source of truth, with state as a deterministic projection. It offers exact replay, cheap forking and goal-to-model-call lineage. In strict replay mode, divergence from the recorded stream raises an error pinned to the first differing event ([arXiv:2605.21997](https://arxiv.org/abs/2605.21997)). Srinivasan introduces the **stochastic-deterministic boundary (SDB)**, the point where an LLM output becomes a system action, as "the load-bearing primitive of production agent runtimes." The same paper names **replay divergence**: consumers of a deterministic log produce different outputs after a model or prompt change, which breaks event-sourcing audit assumptions ([arXiv:2605.20173](https://arxiv.org/abs/2605.20173)). Gonuguntla quantifies the effect on SWE-bench trajectories. After a model swap, 61-94% of post-fork actions are rewritten, and only 3% of replayed states stay valid. Log-stitching evaluation of routers "mispredicts every success-relevant outcome call." Even FP8 serving of the *same* model diverged on over 90% of forks ([arXiv:2608.08239](https://arxiv.org/abs/2608.08239)).

This is the key distinction for the platform. There are two kinds of replay:

- **Replay-as-recovery** (Temporal-style). Recorded LLM outputs are treated as recorded activity results, and the deterministic part is re-executed. This is sound and cheap.
- **Replay-as-re-execution**. The LLM is called again. This is not reproducible and should be treated as *counterfactual simulation*, not as audit.

### 2.3 Transactions, effects and testing

**Atomix** adds progress-aware transactions to tool use. It records reads and effects and separates *bufferable*, *reversible-external* and *irreversible* effects. Commits happen only when no conflicting earlier work remains, and irreversible actions are prevented from leaking under faults or speculation, at microsecond-scale overhead ([arXiv:2602.14849](https://arxiv.org/abs/2602.14849)). **CapLease** identifies *semantic replay*: a single user authorisation gets executed more than once under freshly issued single-use tokens after replanning, retries or crashes. The fix is **durable authorisation state** bound to a canonical action through Issue-Prepare-Commit ([arXiv:2608.01710](https://arxiv.org/abs/2608.01710)).

For testing, deterministic simulation testing (DST) comes from FoundationDB ([Zhou et al., SIGMOD 2021](https://www.foundationdb.org/files/fdb-paper.pdf)) and is now sold by Antithesis through a deterministic hypervisor ([Antithesis docs](https://antithesis.com/docs/introduction/how_antithesis_works/)). DST applies cleanly to the *deterministic shell* of an agent system: state transitions, retries, timeouts, budgets and effect ordering. LLM calls are replaced by recorded or stubbed outputs. **AgentAssay** brings statistical regression testing to agents: three-valued verdicts from hypothesis tests, mutation operators and behavioural fingerprinting. Trace-first offline analysis cuts cost by 78-100% ([arXiv:2603.02601](https://arxiv.org/abs/2603.02601)).

**Implication for the platform.** Durable execution in the Temporal sense is necessary but not sufficient. The platform should (a) record *every* LLM output at the SDB as an event, so recovery replay never calls the model again; (b) separate **replay-for-recovery** (exact, cheap), **replay-for-audit** (re-derive every state transition and invariant check from recorded proposals, which is exact), and **re-execution-for-evaluation** (counterfactual and statistical, reported as a distribution); (c) classify effects the way Atomix does and bind approvals to canonical actions the way CapLease does, so retries and replans cannot re-spend a human approval; (d) offer DST of the deterministic shell with fault injection, and statistical, pass^k-style regression testing of the stochastic parts. For customers on managed APIs, "determinism" should mean *deterministic decisions over recorded proposals*, not bitwise-reproducible LLM output. The platform should say so plainly. For self-hosted inference, batch-invariant serving (Thinking Machines, LLM-42) can be an optional mode.

---

## 3. Structured and constrained agent control

### 3.1 State machines and workflows around LLMs

**StateFlow** models LLM task-solving as a state machine, separating "process grounding" (state and transitions) from "sub-task solving" (actions inside a state). On InterCode SQL and ALFWorld it beat ReAct by 13-28% at 3-5× lower cost ([arXiv:2403.11322](https://arxiv.org/abs/2403.11322)). **AFlow** searches over code-represented workflows with MCTS and lets small models beat larger ones at a fraction of the cost ([arXiv:2410.10762](https://arxiv.org/abs/2410.10762)). **Blueprint First, Model Second** (Alibaba) codifies expert procedure as a source-code "execution blueprint" run by a deterministic engine. The LLM is called for bounded sub-tasks "but never to decide the workflow's path." On τ-bench it reports a 97.6% relative improvement over the prior best and a 96% reduction in constraint violations ([arXiv:2508.02721](https://arxiv.org/abs/2508.02721)). **CAAF** ("Harness as an Asset") argues that domain invariants made executable in a harness become lasting enterprise assets as models commoditise ([arXiv:2604.17025](https://arxiv.org/abs/2604.17025)).

**PatchBoard** swaps inter-agent dialogue for *validated JSON-Patch mutations over a shared, schema-grounded state*, checked by a deterministic kernel. On 630 matched ALFWorld episodes: 84.6% success vs 30.8% for LangGraph, using 45.5k vs 368.3k tokens per success ([arXiv:2605.29313](https://arxiv.org/abs/2605.29313)). This is essentially the SAM *propose → accept → learn* loop applied to multi-agent coordination.

Plan-then-execute lines: ReWOO ([arXiv:2305.18323](https://arxiv.org/abs/2305.18323)), LLMCompiler ([arXiv:2312.04511](https://arxiv.org/abs/2312.04511)), and LLM+symbolic planner hybrids from LLM+P ([arXiv:2304.11477](https://arxiv.org/abs/2304.11477)) to PDDLCoder (89.6% applicable plans vs 74.5% for direct LLM planning; [arXiv:2608.16637](https://arxiv.org/abs/2608.16637)). Anthropic's practitioner guidance separates *workflows* (predefined code paths) from *agents* (LLM-directed control) and recommends the simplest pattern that works ([Anthropic, "Building effective agents", Dec 2024](https://www.anthropic.com/engineering/building-effective-agents)).

### 3.2 Runtime enforcement, shielding and temporal monitors

- **AgentSpec**: a DSL of triggers, predicates and enforcement actions over agent events. It prevented over 90% of unsafe code-agent executions with millisecond overhead ([arXiv:2503.18666](https://arxiv.org/abs/2503.18666)).
- **GuardAgent**: an LLM agent that turns safety requests into guard code and checks another agent's actions ([arXiv:2406.09187](https://arxiv.org/abs/2406.09187)).
- **ShieldAgent**: extracts verifiable policies into probabilistic rule circuits and shields actions through formal verification ([arXiv:2503.22738](https://arxiv.org/abs/2503.22738)).
- **Agent-C**: a temporal-property DSL compiled to first-order logic and checked by SMT *during token generation*. Conformance went from 77.4% to 100% (Claude Sonnet 4.5) and 83.7% to 100% (GPT-5) on retail and airline scenarios, and utility went *up* ([arXiv:2512.23738](https://arxiv.org/abs/2512.23738)). This is strong evidence that hard enforcement does not have to cost intelligence.
- **AgentLTL**: first-order LTL over traces gives a "deterministic, judge-free compliance score." Block-and-warn harnessing improved compliance for 5 of 7 models, and training on it added +38 / +17.5 points ([arXiv:2607.02599](https://arxiv.org/abs/2607.02599)).
- **Pro2Guard / ProbGuard**: learns a DTMC over abstract states from traces and uses probabilistic model checking to intervene *before* an unsafe state becomes likely, with PAC guarantees ([arXiv:2508.00500](https://arxiv.org/abs/2508.00500)).
- **Causal Past Logic**: a past-time temporal logic for guards in *distributed* agent workflows, evaluated locally by the lifeline that owns a branch ([arXiv:2605.20923](https://arxiv.org/abs/2605.20923)).
- **C-Trace**: formalises GDPR requirements (consent, purpose limitation, minimisation, erasure) as trace policies enforced at runtime. It keeps attack success ≤12% under 10% extraction noise ([arXiv:2606.19242](https://arxiv.org/abs/2606.19242)).

### 3.3 Formal verification of agent workflows

**TraceFix** generates multi-agent coordination protocols in PlusCal and repairs them from TLC counterexamples. It reached 100% verification on 48 tasks within four repair iterations, and TLC-verified protocols cut deadlock/livelock from 31.1% to 14.1% at runtime ([arXiv:2605.07935](https://arxiv.org/abs/2605.07935)). A 2026 systematic review of 38 studies ("Toward Safe LLM Agents") gives the sobering counterweight:

1. NL→formal-spec translation reaches only **24-35% semantic correctness**.
2. Runtime monitoring, the most mature strategy, cuts unsafe actions by 40-65%.
3. A **"verifier tax"**: blocking 94% of unsafe actions still does not ensure task-level safety, because agents route around blocks.
4. No approach yet achieves soundness, scalability, semantic correctness *and* task-level safety together ([arXiv:2608.14590](https://arxiv.org/abs/2608.14590)).

### 3.4 Policy-as-code

Cedar is a purpose-built, analysable authorisation language with a verified evaluator ([Cutler et al., OOPSLA 2024, arXiv:2403.04651](https://arxiv.org/abs/2403.04651)). AWS AgentCore Policy puts Cedar on the tool gateway with default-deny, evaluating *each tool call with caller identity and input parameters* at invocation time. It also offers NL→Cedar authoring through a neuro-symbolic loop ([AWS Security Blog](https://aws.amazon.com/blogs/security/why-policy-in-amazon-bedrock-agentcore-chose-cedar-for-securing-agentic-workflows/)). **Progent** provides a privilege-control DSL for tool calls with fallbacks and dynamic policy updates ([arXiv:2504.11703](https://arxiv.org/abs/2504.11703)).

**Implication for the platform.** This is the most crowded area and the one closest to the thesis, so differentiation needs care. The literature converges on a *propose → validate → commit* architecture: PatchBoard, Blueprint-First, Agent-C, AgentSpec, CAAF. The field has **per-action guards** (Cedar, Progent, AgentSpec) and **trace-level temporal monitors** (Agent-C, AgentLTL). What is rare is a **design-time model-checked control model with the same artefact enforcing at runtime**. TraceFix is the nearest neighbour, and it generates protocols rather than governing LLM steps. The platform's differentiator is to hold *one* artefact, the SAM model plus invariants, that is (i) model-checked before deployment, (ii) the runtime acceptor, and (iii) the replay oracle for audit. The "verifier tax" and the 24-35% spec-correctness figures are direct warnings. Enforcement without *state-aware recovery paths* makes agents route around blocks, and invariant *elicitation* is the bottleneck, not checking. The platform therefore needs (a) rejection that returns structured, state-derived feedback so the LLM can re-plan inside the allowed space (Agent-C's utility gains show this works); (b) human-in-the-loop invariant elicitation with counterexamples; and (c) a Cedar-compatible per-action policy layer, not a competitor to it. Enterprises will already have Cedar or OPA.

---

## 4. Security: prompt injection by design

### 4.1 Architectural defences

Willison's **Dual LLM** pattern ([2023](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/)) and **lethal trifecta** (private data + untrusted content + external communication; [June 2025](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)) set the threat model. Detection-based defences are probabilistic. Architecture is the only robust mitigation.

**CaMeL** (Google DeepMind / ETH) is the first concrete Dual-LLM implementation. A privileged LLM writes a program from the trusted query, a quarantined LLM parses untrusted data without tool access, and a custom interpreter tracks capabilities and data flow and enforces policies. It solves 77% of AgentDojo tasks with provable security vs 84% undefended ([arXiv:2503.18813](https://arxiv.org/abs/2503.18813); benchmark: AgentDojo [arXiv:2406.13352](https://arxiv.org/abs/2406.13352)).

**Design Patterns for Securing LLM Agents** (Beurer-Kellner, Tramèr et al.; authors from Google, Microsoft, IBM, ETH, EPFL, Invariant Labs) defines six patterns: Action-Selector, Plan-Then-Execute, LLM Map-Reduce, Dual LLM, Code-Then-Execute and Context-Minimization. Its central principle: once an agent has ingested untrusted input, it must be constrained so that input cannot trigger consequential actions ([arXiv:2506.08837](https://arxiv.org/abs/2506.08837)). A follow-up gives implementation guidance for secure plan-then-execute ([arXiv:2509.08646](https://arxiv.org/abs/2509.08646)).

**FIDES** (Microsoft) is a planner that propagates confidentiality and integrity labels through messages, tool calls and results. It executes consequential actions only if a label policy is met, and it formally characterises what dynamic taint tracking can enforce ([arXiv:2505.23643](https://arxiv.org/abs/2505.23643); [code](https://github.com/microsoft/fides)).

### 4.2 MCP and tool supply chain

MCP's ecosystem widens the attack surface. **MCPTox** runs tool-poisoning attacks, with malicious instructions in tool *metadata*, across 45+ real MCP servers and reports attack success over 60% on several models ([arXiv:2508.14925](https://arxiv.org/abs/2508.14925)). A comparison of seven MCP clients finds tool poisoning is the most prevalent client-side vulnerability ([arXiv:2603.22489](https://arxiv.org/abs/2603.22489)). See also the landscape analysis of Hou et al. ([arXiv:2503.23278](https://arxiv.org/abs/2503.23278)) and the MCP Safety Audit ([arXiv:2504.03767](https://arxiv.org/abs/2504.03767)). The protocol is maturing. The 2025-11-25 spec added OIDC discovery, incremental scopes, step-up authorisation, URL-mode elicitation and experimental durable *tasks* ([changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)). The 2026-07-28 release makes the core **stateless** (no initialize handshake or sessions), moves Tasks to an official extension with `tasks/get|update|cancel`, hardens OAuth/OIDC alignment, and adds a formal deprecation policy with windows of at least 12 months ([MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)).

**Implication for the platform.** The SAM split lines up directly with the security literature. **The state machine is the privileged planner.** It decides what may happen next from state that untrusted content cannot write into except through typed, validated proposals. That is Plan-Then-Execute, Action-Selector and CaMeL-style control-flow integrity, all enforced by construction. The platform should adopt information-flow labels (FIDES) on state fields and proposal payloads. Invariants can then say things like "no field derived from an untrusted source flows into an external-send action without approval," which makes the lethal trifecta a *checkable invariant*, not a review guideline. MCP tools should be registered through the platform, not called directly. Tool metadata should be pinned and hashed, because metadata changes are a poisoning vector. Tool capabilities should be classified by trifecta leg, and MCP Tasks mapped onto durable platform activities. Because stateless MCP (2026-07-28) moves session state to the client, the platform is the natural owner of that state.

---

## 5. Multi-agent and human collaboration

### 5.1 Orchestration patterns

Anthropic's research system uses an orchestrator-worker pattern (Opus lead, Sonnet sub-agents). It beat a single agent by 90.2% on an internal eval, and token usage explained about 80% of performance variance. The write-up stresses that such systems are stateful and errors compound, so they need durable execution, resume-from-checkpoint and full production tracing ([Anthropic, June 2025](https://www.anthropic.com/engineering/multi-agent-research-system)). **Blackboard** architectures, descended from Hearsay-II, are being revived for LLMs. Agents volunteer against a shared board instead of being dispatched by a rigid controller, and they use fewer tokens ([arXiv:2507.01701](https://arxiv.org/abs/2507.01701); [arXiv:2510.01285](https://arxiv.org/abs/2510.01285)). PatchBoard (§3.1) is a *typed, validated* blackboard. The classical **Contract Net** protocol (Smith, IEEE Trans. Computers, 1980) is the conceptual ancestor of A2A-style task delegation.

### 5.2 Protocols

**A2A** reached v1.0 in March 2026. It moved from Google to the Linux Foundation in 2025 and, on 17 Aug 2026, into the **Agentic AI Foundation (AAIF)**, which hosts MCP ([Forbes, Aug 2026](https://www.forbes.com/sites/janakirammsv/2026/08/19/agent2agent-joins-the-agentic-ai-foundation-alongside-mcp/); [LF](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)). IBM's ACP merged into A2A. Cisco's **AGNTCY** (LF, July 2025) covers discovery, identity and observability ([summary](https://zylos.ai/research/2026-03-26-agent-interoperability-protocols-mcp-a2a-acp-convergence/)).

### 5.3 Delegation, identity, authorisation

South et al. propose *authenticated delegation*: third parties can verify that (a) the entity is an agent, (b) acting for a specific human, (c) with specific scoped permissions. It extends OAuth 2.0/OIDC ([arXiv:2501.09674](https://arxiv.org/abs/2501.09674); ICML 2025 position). IETF drafts include OAuth *On-Behalf-Of for AI Agents* (a `requested_actor` parameter and delegation-chain claims; [draft](https://datatracker.ietf.org/doc/html/draft-oauth-ai-agents-on-behalf-of-user-02)) and *AI Agent Authentication and Authorization* on WIMSE plus OAuth ([draft-klrc-aiagent-auth](https://datatracker.ietf.org/doc/draft-klrc-aiagent-auth/)). NIST's **AI Agent Standards Initiative** (CAISI, Feb 2026) and an NCCoE concept paper on agent identity and authorisation cover authentication, authorisation, auditing, non-repudiation and prompt-injection mitigation ([NIST](https://www.nist.gov/news-events/news/2026/02/announcing-ai-agent-standards-initiative-interoperable-and-secure)). Authorisation propagation across multi-agent chains is an open research topic ([arXiv:2605.05440](https://arxiv.org/abs/2605.05440)).

### 5.4 Human-in-the-loop

Turan shows that **oversight has a capacity**. Reviewers only moderately agree on what is risky (Fleiss' κ = 0.52). Under fatigue, safety is an *inverted U* in the escalation rate: more escalation can make the system *less* safe. The safety-optimal guard escalates *below* saturation. A *flooding attack* can exploit reviewer fatigue ([arXiv:2606.08919](https://arxiv.org/abs/2606.08919)). Automation bias compounds this.

**Implication for the platform.** Multi-agent coordination should go through **typed shared state with validated transitions** (blackboard/PatchBoard style), not free-form chat. MAST's inter-agent misalignment cluster is largely a symptom of unstructured coordination. Parent/child state machines give A2A delegation a verifiable contract: a child's accepted outputs are proposals to the parent. Human approval should be a **first-class state-machine transition** with its own identity, delegation chain and durable authorisation record (CapLease). It should not be an out-of-band callback. Escalation policy should be *budgeted*. The platform should track reviewer load, route by calibrated risk, and detect flooding. Every action should carry a delegation chain (human → agent → sub-agent → tool) compatible with OAuth OBO and WIMSE drafts, because regulators (§8) and NIST will ask for exactly that.

---

## 6. Learning from traces

### 6.1 Procedural memory and workflow induction

**Agent Workflow Memory** induces reusable workflows from successful trajectories and improves Mind2Web and WebArena success by 24.6% and 51.1% relative ([arXiv:2409.07429](https://arxiv.org/abs/2409.07429)). **Voyager** keeps a skill library of verified code ([arXiv:2305.16291](https://arxiv.org/abs/2305.16291)). **ACE** evolves context "playbooks" through Generator/Reflector/Curator roles with incremental, structured updates that avoid context collapse (+10.6% on agents; [arXiv:2510.04618](https://arxiv.org/abs/2510.04618)). The **Darwin Gödel Machine** self-modifies agent code under empirical validation ([arXiv:2505.22954](https://arxiv.org/abs/2505.22954)). Its authors note the safety need for sandboxing and lineage.

### 6.2 Process mining of agent logs

This moved quickly in 2026. **Agent Behavior Mining** (SAP authors) defines an event data model that maps reasoning, tool use and token cost into standard process logs. It was applied to a multi-agent order-to-cash process, and practitioners called behavioural transparency "a prerequisite for trust" ([arXiv:2606.20669](https://arxiv.org/abs/2606.20669)). **Agent Mentor** treats trajectories as event logs to recover task-flow structure ([arXiv:2604.10513](https://arxiv.org/abs/2604.10513)). A BlueSky agenda argues for *event-to-action* process mining with "governance contracts" and "action evidence packages," where "act, defer, ask, and refuse are all valid outputs" ([arXiv:2609.07984](https://arxiv.org/abs/2609.07984)). Workflow-graph mining is also used for boundary testing of conversational agents ([arXiv:2607.06873](https://arxiv.org/abs/2607.06873)). The object-centric event log standard [OCEL 2.0](https://www.ocel-standard.org/) and declarative process constraints (Declare, Pesic & van der Aalst 2006) are the natural formats.

### 6.3 Mining specifications and rules

**PrefixGuard** induces typed-step adapters from raw traces and trains *online* failure-warning monitors (AUPRC 0.90 WebArena, 0.71 τ²-bench) that beat LLM judges. Extracted automata stay compact (20-29 states) in some domains and grow to 151-187 in others ([arXiv:2605.06455](https://arxiv.org/abs/2605.06455)). **AgentPex** extracts checkable rules from system prompts and finds violations that outcome scoring misses on 424 τ²-bench traces ([arXiv:2603.23806](https://arxiv.org/abs/2603.23806)). **AutoSpec** evolves expert safety rules from annotated traces through CEGIS plus inductive logic programming. It reports rule F1 of 0.98/0.93, up to 94% fewer false positives, convergence in 4-5 iterations, and human-auditable output ([arXiv:2606.24245](https://arxiv.org/abs/2606.24245)). Pro2Guard learns DTMCs from traces (§3.2).

**Implication for the platform.** A SAM-based runtime produces unusually good event logs. Each step is an *(action, proposal, accepted/rejected, resulting state)* tuple with a known control state, which is much cleaner than raw LLM transcripts. The platform should (a) export OCEL-compatible logs natively, (b) run *invariant mining* over accepted and rejected proposals (AutoSpec/PrefixGuard style) to **suggest** new invariants and guards, and (c) *never auto-promote* them. Mined rules should enter the same elicitation → model-check → versioned-deploy pipeline as human-authored ones. This is the "self-improving agents with guardrails" pattern: the LLM side learns freely (ACE-style playbooks, AWM-style workflows as *how* knowledge), while the *what* side only changes through verified, versioned promotion. Rejection logs are a particularly valuable and under-used signal. Every rejected proposal is a labelled negative example.

---

## 7. Evaluation and observability

### 7.1 Tracing standards

OpenTelemetry's GenAI semantic conventions now model agent runs as span trees: `invoke_agent` → `chat` → `execute_tool`. Operations include `create_agent`, `plan` and `invoke_workflow`, and MCP calls are covered too. As of mid-2026 **every** `gen_ai.*` convention is still marked *Development*. In v1.42.0 (12 June 2026) they moved to a dedicated GenAI conventions repository with their own release cadence ([summary](https://dev.to/azena-ai/opentelemetrys-genai-semantic-conventions-are-not-stable-yet-heres-what-actually-shipped-in-2026-3mke); [Greptime](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions)). Research on *reconstructability* of agent decisions from vendor SDK traces finds large gaps ([arXiv:2605.12078](https://arxiv.org/abs/2605.12078)). DEMM-Bench asks whether runtime governance evidence is *sufficient* ([arXiv:2606.20634](https://arxiv.org/abs/2606.20634)).

### 7.2 LLM-as-judge reliability

The largest evaluation to date (21 judges, 9 providers, about 541k judgments) finds kappa deflation of 33-41 points when chance is corrected for. Judge rankings shift by up to 14 positions across benchmarks. It also finds a "consistency-bias paradox": test-retest reliability above 0.95 alongside position bias above 0.10 ([arXiv:2606.19544](https://arxiv.org/abs/2606.19544)). For false-success detection, the best LLM-judge configuration reached AUROC ≤0.65 on τ²-bench, while **TF-IDF detectors reached 0.83-0.95, caught 4-8× more false successes, and ran 3,300× faster** ([arXiv:2606.09863](https://arxiv.org/abs/2606.09863)). PrefixGuard likewise finds supervised monitors beat LLM judges ([arXiv:2605.06455](https://arxiv.org/abs/2605.06455)). AgentProp-Bench: substring evaluation κ = 0.049, GPT-4o-mini judge κ = 0.567, humans κ = 0.835 ([arXiv:2604.16706](https://arxiv.org/abs/2604.16706)). Background: Zheng et al. ([arXiv:2306.05685](https://arxiv.org/abs/2306.05685)); Agent-as-a-Judge ([arXiv:2410.10934](https://arxiv.org/abs/2410.10934)); small open judges and guard models such as Prometheus 2 ([arXiv:2405.01535](https://arxiv.org/abs/2405.01535)), Llama Guard ([arXiv:2312.06674](https://arxiv.org/abs/2312.06674)) and Granite Guardian ([arXiv:2412.07724](https://arxiv.org/abs/2412.07724)).

**Implication for the platform.** Evaluation should be **layered by cost and certainty**:

1. **Deterministic checks** (invariants, temporal properties, AgentLTL-style compliance scores) are free, exact and judge-free, and should be the primary signal.
2. **Small, calibrated, domain-trained classifiers** ("System-1 judges") handle online triage of semantic properties such as false success, drift and risk scoring. The 2026 evidence is that they beat LLM judges at a fraction of the latency.
3. **LLM judges** are reserved for offline, sampled, meta-evaluated assessment, with chance-corrected agreement reported.

The platform should emit OTel GenAI spans (tracking the unstable conventions behind an adapter) and add its own attributes for control state, proposal ID, accept/reject verdict, invariant IDs checked and model/prompt versions. That turns OTel traces into governance evidence instead of debugging output. Calibration data comes for free from human approvals and rejections at HITL transitions.

---

## 8. Enterprise and regulatory requirements

**EU AI Act** ([Regulation (EU) 2024/1689](https://eur-lex.europa.eu/eli/reg/2024/1689/oj)):

- **Art. 12**: high-risk systems must "technically allow for the automatic recording of events (logs) over the lifetime of the system," to identify risk situations, support post-market monitoring and monitor operation ([Art. 12](https://artificialintelligenceact.eu/article/12/)).
- **Art. 14**: effective human oversight, including the ability to understand, monitor, override and interrupt ("stop button").
- **Art. 19 and Art. 26**: providers and deployers keep logs for at least six months ([Art. 19](https://artificialintelligenceact.eu/article/19/)).
- **Arts. 53/55**: GPAI obligations applied from 2 Aug 2025.
- **Timeline**: the **Digital Omnibus on AI** was provisionally agreed on 7 May 2026, received Council final approval in late June, and entered into force on 27 July 2026. It **defers stand-alone Annex III high-risk obligations to 2 December 2027** and Annex I product-embedded ones to 2 August 2028 ([Consilium, 29 Jun 2026](https://www.consilium.europa.eu/en/press/press-releases/2026/06/29/artificial-intelligence-council-gives-final-green-light-to-simplify-and-streamline-rules/); [Gibson Dunn](https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/)).
- **Standards**: harmonised standards for logging are still drafts: prEN 18229-1 (logging and human oversight) and ISO/IEC DIS 24970 (AI system logging) ([Help Net Security, Apr 2026](https://www.helpnetsecurity.com/2026/04/16/eu-ai-act-logging-requirements/)).

**NIST**: AI RMF 1.0 ([NIST AI 100-1](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf)) and the Generative AI Profile ([NIST AI 600-1](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)), plus the 2026 AI Agent Standards Initiative (§5.3). **ISO/IEC 42001:2023** defines an AI management system that auditors certify against ([ISO](https://www.iso.org/standard/81230.html)). **SOC 2** has no AI-specific criteria. Auditors map agent controls onto existing Trust Services Criteria (change management, logical access, monitoring), so versioned, access-controlled, logged changes to agent logic are what gets tested. **GDPR-as-runtime-policy** is feasible (C-Trace, [arXiv:2606.19242](https://arxiv.org/abs/2606.19242)).

**Implication for the platform.** The Omnibus deferral gives enterprises until December 2027 for Annex III systems. That is a realistic build-and-sell window, not a reason to wait. The platform's event log and state-machine model map closely onto the regulatory vocabulary:

- **Art. 12 logging**: the event-sourced journal, with retention of at least six months, tamper-evidence and export.
- **Art. 14 oversight**: HITL transitions, a first-class interrupt/stop action in every machine, and override recorded as an event.
- **Art. 13 transparency and explainability**: every decision can be explained as "state S, proposal P, rule R accepted or rejected it." This is a *causal, symbolic* explanation, which is much stronger than post-hoc rationalisation of LLM reasoning.

The platform should ship a **compliance evidence pack**: the model, invariants, model-check results, version history and a sample of replays, mapped to Art. 12/14/19, ISO 42001 Annex A controls and NIST RMF functions. It should also track prEN 18229-1 and ISO/IEC 24970 so logs conform when those are finalised.

---

## 9. Versioning and evolution of long-running processes

### 9.1 Classic BPM results still apply

Workflow schema evolution and **instance migration** were studied thoroughly in the BPM literature. Casati et al. formalised workflow evolution ([DKE 1998](https://doi.org/10.1016/S0169-023X(97)00033-5)). Rinderle, Reichert and Dadam surveyed *correctness criteria* for migrating running instances to a new schema: compliance, meaning the instance's trace could have been produced by the new schema, and state-related criteria ([DKE 2004](https://doi.org/10.1016/j.datak.2004.01.002)). Weber, Reichert and Rinderle-Ma catalogued change patterns ([DKE 2008](https://doi.org/10.1016/j.datak.2008.05.001)). Industrial durable-execution engines follow a simpler strategy: pin running executions to code versions and use explicit patch markers ([Temporal worker versioning](https://docs.temporal.io/worker-versioning)).

### 9.2 New drift sources in agentic systems

Agent systems add three drift sources on top of code:

1. **Model drift**. The same model name has been shown to change behaviour over time ([Chen, Zaharia, Zou, arXiv:2307.09009](https://arxiv.org/abs/2307.09009)), and swapping models mid-trajectory rewrites 61-94% of subsequent actions ([arXiv:2608.08239](https://arxiv.org/abs/2608.08239)).
2. **Prompt and playbook drift**, including self-evolving contexts (ACE).
3. **Protocol drift**. MCP now has a formal 12-month deprecation policy ([MCP](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)).

Replay divergence ([arXiv:2605.20173](https://arxiv.org/abs/2605.20173)) is what versioning is meant to prevent. Work on migrating live expert LLM pipelines proposes reversible Strangler-Fig paths ([arXiv:2606.24598](https://arxiv.org/abs/2606.24598)).

**Implication for the platform.** A SAM model with an explicit state schema makes the BPM correctness criteria *mechanically checkable* in a way code-based durable execution (Temporal) cannot easily match:

- **Compliance check**: can this instance's recorded history be replayed through the new model's acceptors?
- **State-shape check**: does the state round-trip and satisfy the new invariants?
- **Model-check**: do the new invariants hold from each live state?

Version identity for an execution should be the tuple *(state-machine version, invariant-set version, prompt/playbook version, model ID + serving config, tool-schema hashes)*, recorded on every event. Model and prompt upgrades should be treated as version changes with their own gates. Because the state machine decides *what*, a model swap changes *how* steps are done but cannot violate invariants. That bounds replay divergence to the stochastic side, and it is a strong selling point over prompt-only agents.

---

## 10. Synthesis: where the thesis is strong, and where it is exposed

**Strong.** Four independent lines of evidence converge on the architecture.

1. **Failure analyses** (MAST, false success, self-conditioning, context rot) locate most production failures in *control, termination, verification and constraint retention*. The state machine owns exactly those.
2. **Constrained-control results** (Blueprint-First, Agent-C, PatchBoard, StateFlow) show hard structure *raising* utility, not only safety.
3. **Security-by-design** (CaMeL, design patterns, FIDES) requires that untrusted content never controls flow, and the SAM split gives that structurally.
4. **Regulation** asks for logs, oversight and explanation that a symbolic control layer produces as a by-product.

**Exposed.**

1. **Specification is the bottleneck.** NL→spec correctness of 24-35% ([arXiv:2608.14590](https://arxiv.org/abs/2608.14590)) means a model checker proves the wrong properties unless elicitation is excellent.
2. **The verifier tax.** Blocking without re-planning support makes agents route around rules.
3. **Over-structuring.** Anthropic's guidance and METR's trend line both suggest that rigid workflows can cap agent capability as models improve. The machine should constrain *outcomes and effects*, not micromanage reasoning.
4. **Crowding.** Temporal, LangGraph, AWS AgentCore (Cedar policy) and a wave of 2026 governance papers occupy nearby ground. The differentiator has to be the *single verified artefact* across design time, run time and audit time, plus version-safe evolution.

---

## 11. Ranked requirements and innovations supported by the literature

Ranked by (strength of evidence) × (differentiation) × (enterprise pull).

1. **Stochastic-deterministic boundary as a typed proposal interface.** Every LLM output that could cause an effect enters the system only as a typed proposal, which the verified state machine accepts or rejects. Proposals are journalled before any effect happens. *(SDB [2605.20173]; PatchBoard [2605.29313]; Blueprint-First [2508.02721]; CaMeL [2503.18813].)*

2. **One artefact, three times.** The same SAM model plus invariants is model-checked at design time, enforces at run time, and serves as the replay oracle at audit time. Nothing drifts between spec and enforcement. *(TraceFix [2605.07935]; survey gaps [2608.14590].)*

3. **Completion and success as state-machine facts.** "Done" is a reachable terminal state with checked postconditions, never an LLM claim. This directly targets false success, the largest failure class in several domains *(2606.09863; MAST 2503.13657)*.

4. **Three replay modes, clearly separated.** Exact recovery replay (recorded LLM outputs), exact audit replay (re-derive decisions from recorded proposals), and counterfactual re-execution (statistical, reported as pass^k distributions). Divergence is detected and pinned to the first differing event *(2605.21997; 2608.08239)*.

5. **Constraints outside the context window, with state-projected prompts.** Each LLM step receives a fresh, minimal context projected from verified state and relevant invariants. It never relies on a long transcript. This mitigates context rot, compaction loss and self-conditioning *(Chroma; 2509.09677; 2605.08580)*.

6. **Rejection with structured, state-aware feedback and re-planning.** A rejected proposal returns *why*: the violated invariant and the allowed actions from the current state. The LLM can then re-plan within bounds, which avoids the verifier tax *(Agent-C utility gains [2512.23738]; [2608.14590])*.

7. **Information-flow labels on state and proposals.** Confidentiality and integrity labels, so the lethal trifecta and exfiltration rules become model-checkable invariants *(FIDES [2505.23643]; design patterns [2506.08837]; Willison)*.

8. **Effect classification and transactional tool use.** Bufferable, reversible and irreversible effects, with sagas and compensation for reversible ones and gating for irreversible ones. Idempotency keys come from event IDs *(Atomix [2602.14849])*.

9. **Durable, action-bound authorisation and approvals.** A human approval binds to a canonical action and is consumed exactly once, surviving retries, replans and crashes *(CapLease [2608.01710])*. Delegation chains are compatible with OAuth OBO and WIMSE drafts *(2501.09674; IETF drafts)*.

10. **Budgeted, calibrated human oversight.** Escalation is a state transition routed by calibrated risk, with reviewer-load tracking and flooding detection. There is always an interrupt/stop transition for Art. 14 *(2606.08919; EU AI Act Art. 14)*.

11. **Version-safe evolution with mechanical migration gates.** Version identity = (machine, invariants, prompts, model and serving config, tool-schema hashes) on every event. BPM-style compliance checks, state round-trip checks and seeded model checks run against live instances before rollout *(Rinderle et al. 2004; replay divergence; Temporal versioning)*.

12. **Layered evaluation: deterministic checks, then small calibrated classifiers, then sampled LLM judges.** Chance-corrected agreement is reported. Supervised monitors are trained from platform traces and HITL labels *(2606.19544; 2606.09863; 2605.06455; AgentLTL 2607.02599)*.

13. **Invariant and guard mining from accept/reject logs, with verified promotion only.** Mined rules, via ILP/CEGIS or automata, are *suggestions* that go through elicitation, model checking and versioned deploy, never live auto-promotion *(AutoSpec [2606.24245]; PrefixGuard [2605.06455]; Pro2Guard [2508.00500])*.

14. **Native process-mining export (OCEL 2.0) and agent-behaviour analytics.** Mine sequence signatures such as Plan-Execute-Plan loops and missing Verify steps as early-warning signals *(2606.20669; 2606.15579; 2609.07984)*.

15. **OTel GenAI spans enriched with governance attributes.** Control state, proposal ID, verdict, invariant IDs and version tuple, behind an adapter while the conventions are still in *Development* *(OTel GenAI; 2605.12078)*.

16. **Compliance evidence pack.** Auto-generated mapping of logs, model-check results, oversight events and version history to EU AI Act Art. 12/13/14/19, ISO/IEC 42001 and NIST AI RMF/600-1, tracking prEN 18229-1 and ISO/IEC 24970 *(Reg. 2024/1689; Omnibus 2026)*.

17. **Typed shared-state coordination for multi-agent work.** Blackboard/PatchBoard-style validated mutations instead of free chat. A2A delegation is modelled as parent/child machines whose outputs are proposals *(2605.29313; 2507.01701; MAST)*.

18. **Policy-as-code interop.** Evaluate enterprise Cedar/OPA policies per action alongside SAM invariants. Invariants cover *sequence and state*, while Cedar covers *who may do what* *(Cedar [2403.04651]; AgentCore; Progent [2504.11703])*.

19. **MCP governance gateway.** Pinned and hashed tool metadata to block poisoning, trifecta-leg classification per tool, and MCP Tasks mapped to durable activities. The platform owns client-side state under stateless MCP *(MCPTox [2508.14925]; 2603.22489; MCP 2026-07-28)*.

20. **Deterministic simulation testing of the deterministic shell, and pass^k as the headline SLO.** Fault injection over recorded or stubbed LLM outputs. Statistical regression (AgentAssay-style) for the stochastic side, reported as pass^k *(FoundationDB/Antithesis; AgentAssay [2603.02601]; τ-bench [2406.12045], τ²-bench [2506.07982])*.

---

*Caveat: many 2026 citations are single-author or not yet peer-reviewed preprints. Treat their specific numbers as indicative. The convergence across independent groups carries more weight than any single figure.*
