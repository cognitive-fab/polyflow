# 04 — The Temporal integration surface: how the Poly stack lands inside a Temporal estate

**Purpose.** This document maps every Temporal extension point that a governance and verification layer could use. It then places each Poly capability (SAM strict-profile acceptors, polygraph, polyvers, polyrun, polyflow, polycrew, Jev) on its most native seam. The constraint behind every choice is the strategy: **an existing Temporal customer must be able to adopt us without migrating a single workflow**, and the result must look like something Temporal would want to own.

**Method and caveats.** Web research was done on 2026-09-22. Every claim cites a URL, and primary sources (docs.temporal.io, temporalio GitHub, the Temporal blog and changelog) are preferred. Some features are pre-release or in public preview, so their APIs will move. Anything marked **[verify]** is an inference that has not yet been confirmed against SDK source.

Companion documents: `01-durable-execution-landscape.md` (market), `02-agentic-ai-literature.md` (research) and `03-poly-ecosystem-inventory.md` (our assets).

---

## 0. Executive summary

1. **The native install unit is now a Worker/Client Plugin.** Temporal ships a `SimplePlugin` abstraction in Python, TypeScript, Go, Java, .NET and Ruby. One plugin can register activities, workflows, interceptors, data converters and Nexus services, and it can set sandbox passthroughs ([Plugins guide](https://docs.temporal.io/develop/plugins-guide)). Every serious third party already uses this shape: OpenAI Agents (`OpenAIAgentsPlugin`), Google ADK (`GoogleAdkPlugin`), LangGraph (`LangGraphPlugin`), Braintrust (`braintrust.contrib.temporal.BraintrustPlugin`), OpenBox (`openbox.plugin.OpenBoxPlugin`) and Tenuo (`TenuoTemporalPlugin`). **Our product should ship as a `PolyPlugin` that installs in one line** ([OpenAI Agents docs](https://docs.temporal.io/develop/python/integrations/openai-agents); [ADK blog](https://temporal.io/blog/google-adk-temporal-integration-bts); [LangGraph docs](https://docs.temporal.io/develop/python/integrations/langgraph); [Braintrust blog](https://temporal.io/blog/building-observable-ai-agents-temporal-now-integrates-with-braintrust); [OpenBox docs](https://docs.openbox.ai/getting-started/temporal); [Tenuo](https://tenuo.ai/temporal)).
2. **Update validators are a first-class acceptor seam.** A validator is a non-blocking read that accepts or rejects before anything is written to history. A rejected Update leaves "no indication that it was ever requested" in the workflow ([Handling messages](https://docs.temporal.io/handling-messages)). That is exactly a SAM acceptor, with one catch. **Rejects are not durable in history**, so our "observable rejects" doctrine needs its own sink, and rejected Updates are still billable Actions ([Billable actions](https://docs.temporal.io/cloud/actions)).
3. **Governance is now contested ground inside Temporal's own ecosystem.** OpenBox is a listed "Governance" partner. It shipped a joint runtime-governance announcement with Temporal on 2026-07-13, quoting Temporal's AI technical lead ([PR Newswire](https://www.prnewswire.com/news-releases/as-enterprises-move-ai-agents-into-production-openbox-ai-and-temporal-introduce-runtime-governance-for-long-running-agents-302820622.html); [AI partners](https://temporal.io/partners/ai)). On 2026-08-20 Temporal previewed its own **Agent Harness**, which includes a tool-call policy layer ([Agent Harness blog](https://temporal.io/blog/temporal-agent-harness-durable-agent-infrastructure)). Neither offers **pre-deployment proof** (model checking), **fleet-aware version compatibility**, or **calibrated abstention**. Those three are our wedge.
4. **Temporal's governance roadmap is mostly about identity and ops.** It covers Principal Attribution (pre-release, a non-spoofable caller identity in history), SCIM, audit logs for the control plane, Worker Versioning GA, and Priority & Fairness ([Replay 2026](https://temporal.io/blog/replay-2026-product-announcements)). Nothing verifies *what a workflow is allowed to do* before it runs, or whether a new version is safe for in-flight executions beyond replay testing. **That gap is our acquisition thesis.**
5. **The biggest technical risk is language portability of SAM acceptors.** Our machines are JavaScript. Temporal's Python workflows run in a re-importing sandbox and Go/Java have no sandbox at all ([Python sandbox](https://docs.temporal.io/develop/python/python-sdk-sandbox)). We need either a TypeScript-first launch or a deterministic cross-language acceptor runtime (polygen code-gen, or a WASM/QuickJS evaluator). Everything else is packaging.

---

## 1. Extension-point inventory

### 1.1 Plugins (the install unit)

| Item | Findings | Source |
|---|---|---|
| SDKs | `SimplePlugin` in Python (`temporalio.plugin.SimplePlugin`), TypeScript (`@temporalio/plugin`), Go (`temporal.SimplePlugin`), Java, .NET and Ruby | [Plugins guide](https://docs.temporal.io/develop/plugins-guide); [py API](https://python.temporal.io/temporalio.plugin.SimplePlugin.html) |
| What a plugin can contribute | Activities, Workflows, Interceptors (client and worker), Data Converters, Nexus Services, a Workflow Runner/sandbox config (Python) and Context Propagators (Go) | [Plugins guide](https://docs.temporal.io/develop/plugins-guide) |
| Worker hook | `configure_worker` can change task queues, concurrency and interceptors before the worker initializes | [py Plugin](https://python.temporal.io/temporalio.worker.Plugin.html) |
| TS caveat | Users must re-export plugin-provided Workflows from their own workflow module, because TS bundles from a single module | [Plugins guide](https://docs.temporal.io/develop/plugins-guide) |
| Guidance | Plugin authors should replay-test and run with `max_cached_workflows=0` to catch side effects on replay | [Plugins guide](https://docs.temporal.io/develop/plugins-guide) |
| Gaps | The guide does **not** document ordering or conflict resolution when several plugins touch the same config. Go context propagators are appended in order | [Plugins guide](https://docs.temporal.io/develop/plugins-guide) |

Third-party pattern: the partner owns the package, and Temporal owns the docs page and the partner listing. Examples are `braintrust.contrib.temporal`, `openbox-temporal-sdk-python`, `tenuo[temporal]` and `parseablehq/temporal-plugin` ([Braintrust](https://temporal.io/blog/building-observable-ai-agents-temporal-now-integrates-with-braintrust); [OpenBox GitHub](https://github.com/OpenBox-AI/openbox-temporal-sdk-python); [Tenuo GitHub](https://github.com/tenuo-ai/tenuo); [Parseable](https://github.com/parseablehq/temporal-plugin)).

### 1.2 Interceptors

| SDK | Workflow inbound | Workflow outbound | Activity / Nexus / Client | Source |
|---|---|---|---|---|
| Python | `execute_workflow`, `handle_signal`, `handle_query`, **`handle_update_validator`**, `handle_update_handler` | `start_activity`, `start_local_activity`, `start_child_workflow`, `signal_child_workflow`, `signal_external_workflow`, `continue_as_new`, `start_nexus_operation` | Activity inbound/outbound; a client interceptor that also subclasses `worker.Interceptor` is auto-applied to workers | [Inbound](https://python.temporal.io/temporalio.worker.WorkflowInboundInterceptor.html); [Outbound](https://python.temporal.io/temporalio.worker.WorkflowOutboundInterceptor.html); [py interceptors](https://docs.temporal.io/develop/python/interceptors) |
| Go | `ExecuteWorkflow`, `HandleSignal`, `HandleQuery`, **`ValidateUpdate`**, `ExecuteUpdate` (v1.24+) | `ExecuteActivity`, `ExecuteLocalActivity`, `ExecuteChildWorkflow`, `ExecuteNexusOperation`, `UpsertSearchAttributes`, `UpsertMemo`, `SideEffect`, `GetVersion`, `NewContinueAsNewError` | Headers are readable and writable via `WorkflowHeader(ctx)` | [pkg.go.dev interceptor](https://pkg.go.dev/go.temporal.io/sdk/interceptor) |
| TypeScript | `WorkflowInboundCallsInterceptor` (execute, signals, queries, updates) | `WorkflowOutboundCallsInterceptor` (`scheduleActivity`, timers, `startOperation`) | `ActivityInboundCallsInterceptor`, `WorkflowClientInterceptor`, `NexusInbound/OutboundCallsInterceptor`. Workflow interceptors register via `workflowModules` | [TS interceptors](https://docs.temporal.io/develop/typescript/interceptors) |

Key semantics:
- In Python, the interceptors list forms a chain in list order ([py interceptors](https://docs.temporal.io/develop/python/interceptors)).
- **Workflow interceptors execute during replay** and must use replay-safe APIs. `workflow.unsafe.is_read_only()` detects query/validator contexts ([py interceptors](https://docs.temporal.io/develop/python/interceptors)).
- Activity and client interceptors are not replay-constrained, which makes them the natural place for external side effects such as audit export or policy-server calls.
- Precedent: Tenuo carries signed warrants in **Temporal headers** and verifies them in a worker interceptor before every Activity. Denials raise `ApplicationError(non_retryable=True)` ([Tenuo](https://tenuo.ai/temporal)). OpenBox intercepts workflow/activity lifecycle events and dispatches them for evaluation. To stay deterministic it makes those calls through a dedicated `send_governance_event` **activity** ([OpenBox SDK](https://github.com/OpenBox-AI/openbox-temporal-sdk-python)).

### 1.3 Data path: converters, codecs, codec server, failures, external storage

| Item | Findings | Source |
|---|---|---|
| Data converter / payload codec | Pluggable serialization plus codec (compression or encryption), configured per client/worker and contributable by a plugin | [Data conversion](https://docs.temporal.io/dataconversion); [Payload codec](https://docs.temporal.io/payload-codec) |
| Codec Server | An HTTP server (`/encode`, `/decode`, and `/download` for External Storage) that the Web UI and CLI call to render payloads. Configured with `TEMPORAL_DATA_ENCODER_ENDPOINT` | [Codec Server](https://docs.temporal.io/codec-server); [Remote data encoding](https://docs.temporal.io/remote-data-encoding) |
| Failure converter | `EncodeCommonAttributes` moves message and stack into codec-processed payloads | [Failure converter](https://docs.temporal.io/failure-converter) |
| External Storage | Public Preview (May 2026). Claim-check pattern: payloads above a threshold (default 256 KiB) go to S3/GCS/Azure and history holds a reference. Runs after codecs. Must be retained for max run timeout plus namespace retention | [External Storage](https://docs.temporal.io/external-storage); [changelog](https://temporal.io/changelog/external-storage-public-preview) |

### 1.4 Determinism and sandbox

- **Python** uses a sandbox that proxies modules through a custom importer and re-imports per workflow run. Third-party modules that are known to be side-effect-free should be passed through for performance. Plugins can change `SandboxRestrictions` (passthrough modules, invalid members). Escape hatches exist (`sandbox_unrestricted`, `sandboxed=False`, `UnsandboxedWorkflowRunner`) ([Python sandbox](https://docs.temporal.io/develop/python/python-sdk-sandbox)).
- **TypeScript** workflows run in an isolated V8 context from a bundle. Plugin workflows must be re-exported ([Plugins guide](https://docs.temporal.io/develop/plugins-guide)).
- Precedent for making a framework deterministic: Google and Temporal added `google.adk.platform.time/uuid` indirection, which is swapped for `workflow.now()` and `workflow.uuid4()` inside workflows ([ADK integration BTS](https://temporal.io/blog/google-adk-temporal-integration-bts)). SAM needs the same treatment for any clock or ID it reads.

### 1.5 Message passing

| Primitive | Semantics relevant to us | Source |
|---|---|---|
| Signal | Async and durable, written to history. Limit of 10,000 per execution | [Message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing); [limits](https://docs.temporal.io/cloud/limits) |
| Query | Read-only and not in history. Billable when a worker receives it | [Billable actions](https://docs.temporal.io/cloud/actions) |
| **Update + validator** | The validator is a non-blocking read that throws to reject. Accept writes `WorkflowExecutionUpdateAccepted`, and a reject leaves no history trace. Validators are sync in TS; in Go they return `error` | [Handling messages](https://docs.temporal.io/handling-messages); [TS msg](https://docs.temporal.io/develop/typescript/workflows/message-passing); [Go msg](https://docs.temporal.io/develop/go/workflows/message-passing) |
| Update limits | 10 in flight and 2,000 per history. Accepted **and rejected** updates are both billable | [limits](https://docs.temporal.io/cloud/limits); [actions](https://docs.temporal.io/cloud/actions) |
| Signal-with-Start / Update-with-Start | Update-with-Start runs the update before the main method if the workflow is new, which gives "early return" | [Sending messages](https://docs.temporal.io/sending-messages) |
| Async activity completion | An external actor completes an activity with a task token | [Activity execution](https://docs.temporal.io/activity-execution); [py async completion](https://docs.temporal.io/develop/python/asynchronous-activity-completion) |

### 1.6 Nexus

Nexus connects namespaces through **Endpoints**. An Endpoint is a reverse proxy to one target namespace and task queue, fronting a **Service** contract of **Operations**. Operations are **sync** (under a 10 s handler deadline, suitable for Signals, Queries and Updates) or **async** (backed by a workflow, up to 60 days). Retries, rate limiting and circuit breaking are built in ([Nexus](https://docs.temporal.io/nexus); [Operations](https://docs.temporal.io/nexus/operations); [Endpoints](https://docs.temporal.io/nexus/endpoints)).

- Status: Python GA at Replay 2026; TS and .NET in preview ([Replay 2026](https://temporal.io/blog/replay-2026-product-announcements)).
- Cloud limits: 30 in-flight Nexus ops per workflow; 100 endpoints per account ([limits](https://docs.temporal.io/cloud/limits)).
- Temporal names Nexus "the foundation for tool calling and agent communication" ([Doubling down on AI](https://temporal.io/blog/doubling-down-on-ai)).
- Tenuo already propagates attenuated warrants over Nexus ([Tenuo](https://tenuo.ai/temporal)).

### 1.7 Visibility and UI

| Item | Findings | Source |
|---|---|---|
| Custom Search Attributes | Cloud limits per namespace: 20 each of Bool, Datetime, Double and Int; 40 Keyword; 5 KeywordList; 5 Text. Each upsert is a billable Action (SAs set at start are free) | [limits](https://docs.temporal.io/cloud/limits); [actions](https://docs.temporal.io/cloud/actions); [Search attributes](https://docs.temporal.io/search-attribute) |
| Memo | Non-indexed metadata; Go exposes `UpsertMemo` | [Go interceptor](https://pkg.go.dev/go.temporal.io/sdk/interceptor) |
| User metadata | `static_summary` (200 bytes, list view) and `static_details` (20 KB, detail view) are set at start. **Current Details** can be updated during execution. All render as Markdown without images, HTML or scripts | [Enriching UI (py)](https://docs.temporal.io/develop/python/platform/enriching-ui); [TS](https://docs.temporal.io/develop/typescript/platform/enriching-ui); ["Label your agent steps"](https://temporal.io/blog/label-your-agent-steps) |
| Web UI extensibility | Codec Server, saved views and search-attribute filters. **No documented plugin or custom-panel mechanism** | [Web UI](https://docs.temporal.io/web-ui) |
| Worker Status UI | Public preview | [Replay 2026](https://temporal.io/blog/replay-2026-product-announcements) |

Implication: we can surface verification state natively only through **Summary, Details and Current Details (Markdown), Search Attributes, and decoded payloads through a Codec Server**. Anything richer means a separate console or an upstream UI contribution.

### 1.8 Lifecycle primitives

- Child workflows ([docs](https://docs.temporal.io/child-workflows)).
- Continue-as-New, needed before 51,200 events, 50 MB, or 2,000 updates ([CaN](https://docs.temporal.io/workflow-execution/continue-as-new); [event limits](https://docs.temporal.io/workflow-execution/event)).
- Schedules ([docs](https://docs.temporal.io/schedule)).
- Reset by event ID or reset type, with the CLI able to list reset-eligible events ([CLI workflow](https://docs.temporal.io/cli/workflow)).
- **Standalone Activities** (public preview): client-started activities with no workflow, so fewer Actions ([Standalone Activity](https://docs.temporal.io/standalone-activity); [blog](https://temporal.io/blog/standalone-activities-durable-job-processing-now-in-public-preview)).
- **Serverless Workers** on Lambda (public preview; Go, Python and Java) ([changelog](https://temporal.io/changelog/serverless-workers-lambda-public-preview)).

### 1.9 Versioning, replay and history

| Item | Findings | Source |
|---|---|---|
| Worker Versioning (GA, 2026-03-30) | A Worker Deployment plus Build ID identifies a Version. Each deployment has one **Current** and an optional **Ramping** version (percentage). **Pinned** workflows finish on their start version with no patches; **Auto-Upgrade** workflows move and still need patching. Drainage status is reported | [Worker Versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning); [GA blog](https://temporal.io/blog/ga-worker-versioning-public-preview-upgrade-on-continue-as-new) |
| Upgrade on Continue-as-New (preview) | Workflows detect `target_worker_deployment_version_changed` and CaN onto the new version | [GA blog](https://temporal.io/blog/ga-worker-versioning-public-preview-upgrade-on-continue-as-new) |
| Temporal Worker Controller (GA) | A K8s operator with AllAtOnce, Progressive (ramp steps and pauses) and Manual strategies. It supports a **gate workflow** (`workflowType`, `input`/`inputFrom`) that must succeed on every task queue of the new version **before promotion** | [Controller repo](https://github.com/temporalio/temporal-worker-controller); [docs](https://docs.temporal.io/production-deployment/worker-deployments/kubernetes-controller); [DeepWiki spec](https://deepwiki.com/temporalio/temporal-worker-controller/2.1-temporalworkerdeployment) |
| Patching | `patched()` / `deprecate_patch()` markers | [py versioning](https://docs.temporal.io/develop/python/workflows/versioning) |
| Replayer | Python `replay_workflows(fail_fast=False)`, Go `ReplayWorkflowHistoryFromJSONFile`, Java `WorkflowReplayer` / `WorkflowExecutionHistory.fromJson` | [py testing](https://docs.temporal.io/develop/python/best-practices/testing-suite); [Java replayer](https://github.com/temporalio/sdk-java/blob/main/temporal-testing/src/main/java/io/temporal/testing/WorkflowReplayer.java) |
| History export | `temporal workflow show --output json` feeds the replayer. Cloud **Workflow History Export** writes closed histories as protobuf and is billable | [CLI](https://docs.temporal.io/cli/workflow); [Cloud export](https://docs.temporal.io/cloud/export); [actions](https://docs.temporal.io/cloud/actions) |

### 1.10 Control plane, identity and audit

- **Cloud Ops API.** A public HTTP/gRPC API for namespaces, users, service accounts and API keys. It underlies Terraform, `tcld` and the UI ([Ops API](https://docs.temporal.io/ops); [Terraform](https://docs.temporal.io/cloud/terraform-provider)).
- **API keys and service accounts.** Non-human identities for SDKs and CI ([API keys](https://docs.temporal.io/cloud/api-keys); [service accounts](https://docs.temporal.io/cloud/service-accounts)).
- **SAML and SCIM.** SCIM went GA at Replay 2026 ([SCIM](https://docs.temporal.io/cloud/scim); [Replay 2026](https://temporal.io/blog/replay-2026-product-announcements)).
- **Audit Logs.** They cover **control-plane** operations only and export to Kinesis or Pub/Sub. They are not a data-plane decision journal ([Audit logs](https://docs.temporal.io/cloud/audit-logs)).
- **Principal Attribution** (pre-release, 2026-04-30). The server writes a non-spoofable Principal Type and Name into history events (start, signal, cancel, and so on). In Cloud these are users, service accounts or mTLS CN; self-hosted uses `frontend.enablePrincipalPropagation` plus the Authorizer / JWT `sub` ([changelog](https://temporal.io/changelog/workflow-execution-with-principal-attribution-pre-release); [Event docs](https://docs.temporal.io/workflow-execution/event)). **[verify]** Whether validators or interceptors can read the principal in-workflow is undocumented.

### 1.11 2026 agent-era primitives

- **Workflow Streams** (public preview; Python and TS, with Go and Java next). This is a *library* on Signals (batched publish), Updates (long-poll subscribe) and Queries, with topics, offsets, exactly-once dedup, and survival across CaN. Temporal markets it explicitly for "guardrails" and agent monitoring with interrupt ([Workflow Streams docs](https://docs.temporal.io/workflow-streams); [py](https://docs.temporal.io/develop/python/workflows/workflow-streams); [blog, 2026-06-17](https://temporal.io/blog/workflow-streams-live-interactivity-agents-other-applications)).
- **Temporal Agent Harness** (early, pre-preview, 2026-08-20; `temporal-community/temporal-agent-harness`). It is an "outer harness" around OpenAI Agents, PydanticAI and Gemini, and it provides tool-call approval policies such as `ToolApprovalPolicy.allow_inherently_safe()`. Policies are "layered, changed at runtime, scoped… extended with your own predicates", and approvals pause and resume durably. It also offers typed operations, code mode and AgentEvent streams. The post argues "There should be a seam between the model deciding to use a capability and that capability actually executing. That's where your application's controls belong." Its roadmap lists "policy engines, identity systems, observability platforms" as future integrations, and it does not mention verification or model checking ([Agent Harness](https://temporal.io/blog/temporal-agent-harness-durable-agent-infrastructure); [repo](https://github.com/temporal-community/temporal-agent-harness)).

### 1.12 AI framework integrations (how they work)

| Integration | Mechanism | Status | Source |
|---|---|---|---|
| OpenAI Agents SDK (`temporalio.contrib.openai_agents`) | `OpenAIAgentsPlugin` routes every model call through `invoke_model_activity`. Tools are `activity_as_tool` (I/O, receives a *copy* of context), `@function_tool` (deterministic, in-workflow) or hosted tools. MCP servers are registered as worker factories and each MCP op is an Activity. `SandboxAgent` makes every shell/file/PTY op its own Activity. HITL comes from `require_approval` → `on_approval_request` in workflow context (Signals/Updates). `ModelActivityParameters` set timeouts and retries | Core GA; sandbox pre-release; OTel preview; streaming experimental | [docs](https://docs.temporal.io/develop/python/integrations/openai-agents); [SandboxClientProvider](https://python.temporal.io/temporalio.contrib.openai_agents.SandboxClientProvider.html) |
| Google ADK (`temporalio[google-adk]`) | `TemporalModel` puts LLM calls in Activities; `activity_tool`; `GoogleAdkPlugin` does passthroughs, Pydantic serialization and deterministic time/uuid | Experimental in SDK 1.24 | [py integrations](https://docs.temporal.io/develop/python/integrations); [BTS blog](https://temporal.io/blog/google-adk-temporal-integration-bts); [ADK docs](https://adk.dev/integrations/temporal/) |
| LangGraph (`temporalio.contrib.langgraph`) | Each graph node runs as an Activity; LangSmith trace propagation | Public preview | [docs](https://docs.temporal.io/develop/python/integrations/langgraph); [blog](https://temporal.io/blog/temporal-langgraph-plugin-durable-execution) |
| Pydantic AI | Maintained by Pydantic. Model requests, I/O tools and MCP go to Activities; the agent run is the workflow | Native in Pydantic AI | [Pydantic docs](https://ai.pydantic.dev/durable_execution/temporal/); [Temporal blog](https://temporal.io/blog/build-durable-ai-agents-pydantic-ai-and-temporal) |
| Vercel AI SDK (`@temporalio/ai-sdk`) | The plugin wraps `generateText`, `streamText` and similar calls in Activities; targets AI SDK v7 | Released | [docs](https://docs.temporal.io/develop/typescript/integrations/ai-sdk); [npm](https://www.npmjs.com/package/@temporalio/ai-sdk) |
| AI Cookbook | Recipes, including HITL through Signals plus durable timers and a durable MCP server | Docs | [Cookbook](https://docs.temporal.io/ai-cookbook); [HITL](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python); [repo](https://github.com/temporalio/ai-cookbook) |
| Temporal MCP | The official **Knowledge Base MCP** (docs Q&A) plus Developer/Ops/Cloud **Skills** for Claude Code, Cursor and Codex. Community MCP servers drive clusters | Official KB MCP; community servers | [With AI](https://docs.temporal.io/with-ai); [community](https://github.com/alisaitteke/temporal-mcp) |

**Pattern to copy.** Every integration keeps the framework's own API and moves I/O into Activities with a single plugin, so the user never learns a second programming model. Our plugin has to meet that bar.

---

## 2. Ecosystem, acquisitions and leadership signals

### 2.1 Acquisitions and money

| Date | Event | Source |
|---|---|---|
| 2025-09-03 | **Crystal DBA** acquired (AI-for-Postgres). Founder Johann Schleier-Smith is now Temporal's Technical Lead for AI | [Temporal blog](https://temporal.io/blog/temporal-and-the-next-frontier-scaling-ai-reliably); [LinkedIn](https://www.linkedin.com/posts/crystaldba_big-news-crystal-dba-has-been-acquired-by-activity-7369389037263994884-zwAD); [PR Newswire](https://www.prnewswire.com/news-releases/as-enterprises-move-ai-agents-into-production-openbox-ai-and-temporal-introduce-runtime-governance-for-long-running-agents-302820622.html) |
| 2026-02-17 | $300M Series D at $5B (a16z lead) | [Temporal news](https://temporal.io/news/temporal-raises-300M-to-make-agentic-ai-real-for-companies); [GeekWire](https://www.geekwire.com/2026/temporal-raises-300m-hits-5b-valuation-as-seattle-infrastructure-startup-rides-ai-wave/) |
| 2026-04 | **Chkk** and **Adviser Labs** teams join. Chkk's founder leads the AI engineering org; both teams "had chosen to build on Temporal long before we were ever in conversation" | [Doubling down on AI](https://temporal.io/blog/doubling-down-on-ai) |
| 2026-09-14 | $550M Series E at $12.55B. Run rate above $250M (200%+ YoY), 4,300+ paying customers, and use of funds that includes "deepen platform R&D" | [AI Insider](https://theaiinsider.tech/2026/09/14/temporal-closes-550m-funding-round-at-a-12-55b-valuation-as-demand-surges-for-reliable-ai-infrastructure/) |

**Pattern.** Every acquisition so far has been a small, technical, AI-adjacent **team** that was already building on Temporal and was absorbed into the AI org. None was a product line. With a fresh $550M, Temporal can afford capability tuck-ins. The profile that fits is: *built on Temporal, installs as a plugin, customers already running it, fills a named roadmap gap.* We should engineer toward exactly that profile.

### 2.2 Partner program

- The **Temporal AI Partner Ecosystem** launched at Replay 2026 ([Replay recap](https://community.temporal.io/t/replay-26-launch-recap-serverless-workers-standalone-activities-task-queue-priority-fairness-and-much-more/19695)). Listed partners: OpenAI, Pydantic, Vercel, Google Cloud, Braintrust, Langfuse, Mastra, **Tenuo**, Parseable, **OpenBox (Governance)**, Strands, SpringAI and Tuning Engines ([AI partners](https://temporal.io/partners/ai); [partner ecosystem blog](https://temporal.io/blog/announcing-the-temporal-partner-ecosystem)).
- Temporal Cloud is sold on AWS Marketplace (PAYG and credits) ([AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-xx2x66m6fp2lo)), and Temporal holds the AWS AI Competency (Agentic AI) ([Replay 2026](https://temporal.io/blog/replay-2026-product-announcements)). There is no third-party marketplace inside Temporal Cloud; the partner listing is the storefront.
- **How partners ship:**
  - The partner-owned package exposes a Plugin: Braintrust (2026-01-20), OpenBox, Tenuo and Parseable.
  - Temporal writes a blog or docs page and may co-announce. OpenBox got a joint press release that quotes Temporal's AI lead: "Combining durable execution with runtime governance means every action is authorized, recorded, and recoverable" ([PR Newswire](https://www.prnewswire.com/news-releases/as-enterprises-move-ai-agents-into-production-openbox-ai-and-temporal-introduce-runtime-governance-for-long-running-agents-302820622.html)).
  - Partners with deep engineering alignment (OpenAI, ADK, LangGraph) end up **in `temporalio/sdk-python` contrib**. That is the strongest adoption signal to aim for.

### 2.3 What leadership says

- **Samar Abbas (CEO), Series D:** "Agentic AI doesn't fail because the models aren't good enough. It fails because the systems around them can't handle real-world execution" ([GeekWire](https://www.geekwire.com/2026/temporal-raises-300m-hits-5b-valuation-as-seattle-infrastructure-startup-rides-ai-wave/)).
- **Preeti Somal, 2026-04-30:** "The longer agents run and the more they coordinate, the less forgiving the system gets." She names five priorities: win agentic use cases, AI developer experience, **Nexus as the foundation for tool calling and agent communication**, partnerships, and internal agents. The post does not address governance or safety ([Doubling down on AI](https://temporal.io/blog/doubling-down-on-ai)).
- **Cornelia Davis (Agent Harness):** the policy seam belongs between model intent and capability execution, and it should enforce "identity, authorization, business invariants" ([Agent Harness](https://temporal.io/blog/temporal-agent-harness-durable-agent-infrastructure)).
- **Joshua Smith, 2026-04-23:** "you can build approval gates directly into the workflow"; history is "recorded, queryable, and replayable" ([Agent zoo → orchestra](https://temporal.io/blog/from-agent-zoo-to-agent-orchestra-temporal-agentic-control-plane)).
- **Replay 2026 keynote:** Abbas with Replit's Amjad Masad on durable execution for agentic AI. No transcript is available ([keynote page](https://temporal.io/resources/on-demand/replay-2026-open-keynote)).

**Reading.** Temporal's governance story is currently *approval gates, history as audit, and identity*. "Business invariants" appear only as words; no mechanism enforces them. The **verifiable** part (proving invariants hold across all reachable states before deploy, and across versions for in-flight executions) is unclaimed. That is where to plant the flag.

### 2.4 Overlap and gap matrix (Temporal-adjacent governance)

| Capability | Temporal native | Agent Harness | OpenBox | Tenuo | Manetu AgentVisor | **Poly** |
|---|---|---|---|---|---|---|
| Caller identity in history | Principal Attribution (pre-release) | planned | — | cryptographic warrant | host identity | consume |
| Runtime allow/deny per tool/activity | — | ToolApprovalPolicy | ALLOW/CONSTRAIN/REQUIRE_APPROVAL/BLOCK/HALT via remote API (fail-open by default) | offline warrant check | boundary policy | **SAM acceptor, in-process, deterministic** |
| Durable human approval | Signals/Updates (DIY) | yes | yes | — | — | Update-based claims (polycrew) |
| Pre-deploy proof of invariants | — | — | — | — | — | **polygraph model check** |
| In-flight version safety | Replayer + Worker Versioning + controller gate hook | — | — | — | — | **polyvers lanes against fleet snapshots** |
| Calibrated abstention for judgement calls | — | — | — | — | — | **Jev** |
| Tamper-evident decision journal | history (not a policy journal) | AgentEvent streams | attestations + immutable log | signed evidence | — | journal + hash chain |

Sources: [Agent Harness](https://temporal.io/blog/temporal-agent-harness-durable-agent-infrastructure); [OpenBox SDK](https://github.com/OpenBox-AI/openbox-temporal-sdk-python); [Tenuo](https://tenuo.ai/temporal); [Manetu](https://temporal.io/blog/manetu-the-thread-is-the-workflow); [Principal attribution](https://temporal.io/changelog/workflow-execution-with-principal-attribution-pre-release).

**Strategic implication.** Do not compete on runtime policy (OpenBox, Harness) or authorization (Tenuo). Position Poly as **the verification layer those policies can be checked against**. The Harness's "extended with your own predicates" and "policy engines" roadmap is an invitation: ship a `PolyPredicate` adapter for the Harness and an OpenBox-compatible verdict mapping.

---

## 3. Native mappings: capability by capability

Guiding rule: **inside the workflow, only pure and deterministic things; everything with I/O goes in an activity, an activity interceptor, or out of band.** A SAM strict-profile acceptor is pure, so it can run in-workflow at zero Action cost.

### 3.1 Summary table

| Poly capability | Primary Temporal seam | Secondary seams | Visible in Temporal UI as | Action cost |
|---|---|---|---|---|
| **SAM acceptor** (pure accept/reject of proposals) | Update **validator** (`handle_update_validator` / `ValidateUpdate`) for external proposals; **workflow outbound interceptor** (`start_activity`, `start_child_workflow`, `start_nexus_operation`, `continue_as_new`) for internal effects | Signal inbound interceptor (reject with no reply) | Update "Rejected" to the caller; SA `PolyLastReject`; Current Details | 0 in-workflow; each Update is 1 Action whether accepted or rejected |
| **Observable rejects** | Workflow-side reject counter plus a Workflow Streams topic `poly.rejects`; client interceptor mirrors Update rejections to the sink | Failure converter: typed `ApplicationError("PolyReject", non_retryable)` | Stream, SA, Current Details | batched SA upserts |
| **polygraph model-checked admission** | CI gate (GitHub Action) producing a signed certificate bound to the **Worker Deployment Build ID**; `PolyPlugin.configure_worker` **refuses to register** workflow types without a valid certificate | Worker Controller **gate workflow** re-verifies before promotion | `static_details` badge: model hash, invariants, cert ID | 0 at runtime |
| **polyvers** (version compatibility) | Worker Controller **gate workflow** runs polyvers lanes and the **Replayer** over exported histories and SAM snapshots from the live fleet; the result sets the ramp or blocks | Chooses **Pinned vs Auto-Upgrade** per lane; triggers **Upgrade-on-CaN** with a migrated snapshot | Deployment version not promoted; gate workflow result | gate run only |
| **polyrun** (resume from snapshot) | **Continue-as-New carrying the SAM snapshot** as input; Upgrade-on-CaN for version moves | External Storage for large snapshots | CaN chain | 1 per CaN |
| **polyflow work order loop** (agent-facing MCP) | Work order = **Activity** (async completion by task token for external agents) or **Nexus async operation** across teams; MCP tools map to Update (sync, ≤10 s) and Signal | OpenAI/ADK plugin tools via `activity_as_tool`; Standalone Activity for single-shot orders | Activity rows, Nexus op events | 1 per order + heartbeats |
| **polycrew** claims/broker | **Update-based claim protocol** on a broker workflow: `claim` (validator = acceptor on eligibility and lease), `renew`, `release`, `complete`; lease expiry = durable timer | Principal Attribution for claimant identity; Nexus for cross-namespace crews | SA `PolyClaimant`, `PolyLeaseUntil` | 1 per claim op |
| **Decision journal** | In-workflow journal buffer, flushed through a journal activity or an **activity-side exporter** to an external sink; indexed SAs + memo; Markdown Current Details | Codec Server decodes journal payloads; hash chain in a codec; Cloud History Export as the completeness backstop | SAs, memo, Current Details | 1 per flush/upsert (batch) |
| **Jev** calibrated judge | **Activity** returning `{answer, p, abstain, rationale_ref}`; abstention routes to a human via Update | Nexus service "judge" shared across namespaces; Standalone Activity for offline eval | Activity result; Stream event | 1 per judgement |

### 3.2 Details and rationale

**SAM acceptor ↔ Update validator + outbound interceptor.** Temporal's validator contract (synchronous, non-blocking, read-only, throw to reject, nothing written on reject) matches a strict-profile acceptor almost exactly ([Handling messages](https://docs.temporal.io/handling-messages)). That covers *external* proposals: humans, other agents, MCP clients.

For *internal* proposals, where an agent inside the workflow decides to call a tool, the seam is the **workflow outbound interceptor** on `start_activity` and friends. This is the "seam between the model deciding… and that capability actually executing" in Temporal's own words ([Agent Harness](https://temporal.io/blog/temporal-agent-harness-durable-agent-infrastructure)). Because it runs inside the workflow and the acceptor is pure, it replays deterministically and costs nothing.

It composes with the OpenAI Agents and ADK plugins because their tools become activities, so our outbound interceptor sees every tool call ([OpenAI Agents docs](https://docs.temporal.io/develop/python/integrations/openai-agents)). It also sees MCP ops and sandbox ops, since each of those is an Activity too.

Design rule: the acceptor's model must be **pinned per execution**. Pinned Worker Versioning gives this for free, and for Auto-Upgrade, polyvers must certify the change (see below).

**Observable rejects.** A rejected Update leaves no history, so the "observable" half needs:
- a client interceptor that records Update rejections at the caller (the client knows);
- in-workflow rejects (outbound interceptor) recorded in the workflow's journal state, published on a Workflow Streams topic ([Workflow Streams](https://docs.temporal.io/workflow-streams)) and reflected in a Search Attribute.

The effect itself is surfaced as a typed non-retryable `ApplicationError`, following Tenuo's precedent ([Tenuo](https://tenuo.ai/temporal)).

**Model-checked admission ↔ CI gate + plugin refusal + controller gate.**
1. **CI.** A `polygraph verify` step emits a certificate `{workflowType, modelHash, invariantsHash, verdict, buildId}`, signed.
2. **Worker start.** `PolyPlugin` (via `configure_worker`, [py Plugin](https://python.temporal.io/temporalio.worker.Plugin.html)) computes the hash of each registered SAM module and fails closed if the certificate is missing. This is the "worker plugin refusing unverified workflow types."
3. **Promotion.** The Temporal Worker Controller's **gate workflow** must succeed before a version ramps ([controller](https://github.com/temporalio/temporal-worker-controller); [spec](https://deepwiki.com/temporalio/temporal-worker-controller/2.1-temporalworkerdeployment)). We ship `PolyGateWorkflow` as that workflow. It is Temporal's own hook, so this is maximally native.
4. **UI.** Write the certificate summary into `static_details` Markdown on every start (20 KB budget, [Enriching UI](https://docs.temporal.io/develop/python/platform/enriching-ui)).

**polyvers ↔ Worker Versioning ramp gate.** Temporal already says replay testing is "the only way" to ensure backward compatibility ([testing](https://docs.temporal.io/develop/python/best-practices/testing-suite)). It gives the primitives (Replayer, JSON history, Cloud History Export) but not the policy. polyvers adds the policy: classify the change into lanes, then run the lanes' gates against **fleet snapshots**, which are:
- open-workflow histories pulled with `temporal workflow show --output json` ([CLI](https://docs.temporal.io/cli/workflow)), plus closed ones via [History Export](https://docs.temporal.io/cloud/export);
- SAM snapshots read by Query or from memo.

The output drives three decisions: block the gate, set the ramp percentage, and choose a **Pinned vs Auto-Upgrade** behavior per workflow type ([Worker Versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning)). When a shape migration is needed, polyvers scaffolds the migration that runs at **Upgrade-on-Continue-as-New** ([GA blog](https://temporal.io/blog/ga-worker-versioning-public-preview-upgrade-on-continue-as-new)). This is the single most "Temporal-shaped" capability we have, and the easiest to explain to a Temporal PM.

**polyrun ↔ Continue-as-New with snapshot.** Do not try to replace Temporal's replay engine; that would break the no-migration promise. Express polyrun's idea natively instead: the SAM state *is* the snapshot. Checkpoint by Continue-as-New with `{snapshot, journalCursor}` as input, which bounds history (51,200 events / 50 MB / 2,000 updates, [event limits](https://docs.temporal.io/workflow-execution/event)), and use Upgrade-on-CaN to cross versions. polyrun remains our standalone engine for non-Temporal customers.

**polyflow work orders ↔ Activity / Nexus.**
- If the performer is an external agent speaking MCP, each work order is an Activity completed asynchronously by task token ([async completion](https://docs.temporal.io/develop/python/asynchronous-activity-completion)). The polyflow MCP server issues the order to the agent and completes the activity with the result, and the workflow's outbound interceptor has already run the acceptor on the order.
- If the performer is another team's service, expose `WorkOrderService` as a **Nexus** service. Use async operations for real work (≤60 days) and sync operations (≤10 s) for `claim`, `status` and `submit`, which map to Update and Query ([Nexus operations](https://docs.temporal.io/nexus/operations)).
- MCP ergonomics: the polyflow MCP server is a thin client. Its tools map to Update (claim/submit, validated), Query (status) and a Workflow Streams subscription (live feed).

**polycrew ↔ Update-based claims.** One broker workflow per pool, with operations:
- `claim(workId, claimant)`: the validator runs the acceptor on eligibility, lease-free status and capability;
- `renew`;
- `release`;
- `complete(result)`: the validator checks the claimant still holds the lease.

Leases are durable timers. Idempotency comes from Update IDs. Pools must **Continue-as-New** before 2,000 updates, and callers must tolerate the **10 in-flight updates** cap per workflow ([limits](https://docs.temporal.io/cloud/limits)), which pushes large pools toward sharded brokers. Identity: a claimant string in the payload is spoofable; the durable answer is Principal Attribution in history ([Event docs](https://docs.temporal.io/workflow-execution/event)) or Tenuo-style signed headers. **[verify]** Whether the principal is readable inside a validator.

**Decision journal ↔ SAs + memo + metadata + external sink.**
- **Index.** A few custom SAs: Keyword `PolyState`, `PolyModelHash`, `PolyLastReject`; Int `PolyRejectCount`; Bool `PolyVerified`; Datetime `PolyLeaseUntil`. This fits well within Cloud's 40 Keyword / 20 Int / 20 Bool budget ([limits](https://docs.temporal.io/cloud/limits)) but competes with the customer's own attributes, so make names configurable.
- **Human view.** Markdown Current Details showing the SAM state, last N decisions and certificate ([Enriching UI](https://docs.temporal.io/develop/typescript/platform/enriching-ui)).
- **Durable journal.** Buffer in-workflow and flush through a journal activity at step boundaries and at CaN. Alternatively, export from an **activity-side interceptor** (not replay-constrained) to OTel, Kafka or S3. Chain hashes in the payload codec for tamper evidence.
- **Completeness backstop.** Cloud History Export plus Principal Attribution gives an authoritative, server-attested record to reconcile the journal against.

**Jev ↔ calibrated judge activity.** A judgement is non-deterministic I/O, so it is an Activity. It returns a typed answer with calibrated probability and an explicit `abstain`. The acceptor treats `abstain` as "route to human": open a claim on the polycrew broker, or publish a Workflow Streams approval request answered by Update, similar to the OpenAI Agents `on_approval_request` pattern ([OpenAI Agents docs](https://docs.temporal.io/develop/python/integrations/openai-agents)). Offer Jev cross-namespace as a **Nexus service**, following Temporal's "Nexus is the foundation for tool calling" line ([Doubling down](https://temporal.io/blog/doubling-down-on-ai)).

### 3.3 Packaging proposal

| Package | SDK | Contents |
|---|---|---|
| `poly-temporal` (PyPI) / `@poly/temporal` (npm) | Python, TS first | `PolyPlugin` (interceptors, certificate check, journal activity, sandbox passthroughs, data converter for SAM types); `PolyGateWorkflow`; Codec Server handlers |
| `poly-temporal-harness` | Python | `PolyPredicate` for Temporal Agent Harness policies |
| `poly-temporal-openai` / `-adk` | Python | Presets that compose with `OpenAIAgentsPlugin` / `GoogleAdkPlugin` |
| `polyvers-action` | GitHub Action | Fleet snapshot pull → lanes → certificate |
| Go/Java | later | Generated native acceptors (see risk R1) |

TypeScript first is attractive because SAM modules are already JS and the TS workflow isolate is a natural host. Python second, because most AI integrations (OpenAI, ADK, LangGraph, Pydantic) are Python ([py integrations](https://docs.temporal.io/develop/python/integrations)). Python realistically decides adoption, so the portable acceptor (R1) is on the critical path.

---

## 4. Technical risks

| # | Risk | Detail | Mitigation |
|---|---|---|---|
| R1 | **Acceptor language portability** | SAM modules are JS. Python workflows run in a sandbox that re-imports modules and restricts members; Go/Java have no sandbox, so determinism is by discipline ([Python sandbox](https://docs.temporal.io/develop/python/python-sdk-sandbox)). An embedded JS engine in a Python/Go workflow is a determinism and performance hazard | (a) TS first; (b) polygen **code-gen of native acceptors** per SDK, with a cross-language conformance corpus replayed in CI; (c) a WASM-hosted evaluator marked passthrough, or (d) fall back to a local activity (recorded, but 1 Action each) |
| R2 | **Interceptor ordering with other plugins** | The plugins guide does not define ordering when OpenAI Agents, Braintrust, OpenBox and Poly all install interceptors ([Plugins guide](https://docs.temporal.io/develop/plugins-guide)). The Python chain follows list order ([py interceptors](https://docs.temporal.io/develop/python/interceptors)). The acceptor must see the *final* activity input | Install the outbound interceptor last (closest to the server); document the ordering; add a self-test at worker start that detects later mutation |
| R3 | **Replay side effects** | Workflow interceptors re-run on replay ([py interceptors](https://docs.temporal.io/develop/python/interceptors)). Naive audit emission duplicates events or misses them on cache eviction | No I/O in workflow interceptors; journal via activity or activity-side exporter; idempotent sink keyed by (workflowId, runId, eventId) |
| R4 | **Rejected Updates are invisible in history but billable** | No `UpdateRejected` event ([Handling messages](https://docs.temporal.io/handling-messages)); each still counts as an Action ([actions](https://docs.temporal.io/cloud/actions)) | Client-side mirror of rejections; pre-validate in the MCP/Nexus front door to avoid paying for doomed Updates |
| R5 | **History and payload limits** | 51,200 events / 50 MB; 2 MB payload; 4 MB transaction; 2,000 updates; 10 in-flight updates; 30 in-flight Nexus ops ([limits](https://docs.temporal.io/cloud/limits)) | Journal out of history; CaN with snapshot; External Storage (256 KiB threshold) for large snapshots ([External Storage](https://docs.temporal.io/external-storage)); shard brokers |
| R6 | **Cost per governed action** | $50 per million Actions list price, falling to $25 self-serve ([pricing](https://temporal.io/pricing)). Billable items include SA upserts, heartbeats, updates (accepted or rejected), queries and history export ([actions](https://docs.temporal.io/cloud/actions)). A naive design (a policy activity per tool call, like OpenBox's `send_governance_event`, plus an SA upsert plus an audit activity) can **double to quadruple** a customer's bill | Keep the acceptor in-workflow (0 Actions); batch journal flushes; upsert SAs only on state change; publish a cost model. "Governance adds <10% Actions" is a selling point against remote-verdict competitors |
| R7 | **Acceptor change = workflow code change** | Changing a SAM model changes workflow command sequences, so Auto-Upgrade executions can hit NDEs | This is exactly the polyvers use case. Default to Pinned for governed types; certify Auto-Upgrade moves |
| R8 | **Preview-feature churn** | Workflow Streams, External Storage, Principal Attribution, Agent Harness, OpenAI sandbox and ADK are preview, pre-release or experimental ([Replay 2026](https://temporal.io/blog/replay-2026-product-announcements); [py integrations](https://docs.temporal.io/develop/python/integrations)) | Depend only on GA seams (plugins, interceptors, Updates, Worker Versioning, Replayer, Nexus in Python/Go/Java); treat previews as optional adapters |
| R9 | **No UI extension point** | The Web UI offers only a Codec Server, saved views and Markdown metadata ([Web UI](https://docs.temporal.io/web-ui)) | Use metadata and SAs to the full; build a thin Poly console that deep-links into Temporal UI; consider an upstream PR to `temporalio/ui` |
| R10 | **Strategic overlap with Temporal's own Harness** | Temporal may absorb runtime policy itself ([Agent Harness](https://temporal.io/blog/temporal-agent-harness-durable-agent-infrastructure)) | Be the verifier behind the Harness (PolyPredicate), not a rival harness; own pre-deploy and version-safety, which the Harness does not address |
| R11 | **Partner incumbency** | OpenBox holds the "Governance" partner slot and a co-marketed launch ([PR Newswire](https://www.prnewswire.com/news-releases/as-enterprises-move-ai-agents-into-production-openbox-ai-and-temporal-introduce-runtime-governance-for-long-running-agents-302820622.html)) | Differentiate on in-process determinism (OpenBox defaults to **fail-open** remote calls, per [OpenBox SDK](https://github.com/OpenBox-AI/openbox-temporal-sdk-python)) and on proof. Apply to the AI partner program under a "Verification" category |
| R12 | **Nexus sync deadline** | Sync ops must finish in <10 s ([Nexus](https://docs.temporal.io/nexus)) | Judge and work orders use async ops; only claim and status are sync |

---

## 5. Recommended first 90 days (Temporal-facing)

1. **TS + Python `PolyPlugin` MVP** built on GA seams only: an outbound acceptor interceptor, an Update-validator adapter, certificate refusal at worker start, `static_details` badge, and SA/Current Details journal index.
2. **`PolyGateWorkflow` for the Temporal Worker Controller.** It runs polyvers lanes and the Replayer over a fleet snapshot, which makes for a strong demo: "the ramp that refused to promote."
3. **Composition demo** with `OpenAIAgentsPlugin`: the same agent, zero code changes, every tool call accepted or rejected by a verified SAM machine, with the Action overhead measured.
4. **Harness adapter** (`PolyPredicate`) and a public write-up aimed at Temporal's AI team (Schleier-Smith, Davis).
5. **Apply to the AI partner ecosystem** ([AI partners](https://temporal.io/partners/ai)) under a Verification category, and target a Replay 2027 talk.

---

## 6. Open questions to verify in SDK source

- Can a workflow inbound interceptor or validator read Principal Attribution for the current Update or Signal? (Not documented.)
- How is plugin ordering resolved in TS, Go and .NET when multiple plugins add interceptors?
- Do validators run on replay for previously accepted Updates in each SDK? This matters for the acceptor purity budget.
- Does the Web UI render Markdown links in Current Details, which would allow deep links to a Poly console? The docs only exclude images, HTML and scripts.
- Worker Controller gate workflow: timeout behavior, and whether a failure can carry a structured report back to the operator.
