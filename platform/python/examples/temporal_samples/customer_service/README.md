# Temporal's `openai_agents/customer_service`, governed at G1

The official sample ([temporalio/samples-python `openai_agents/customer_service`](https://github.com/temporalio/samples-python/tree/main/openai_agents/customer_service),
pinned at `4e2f01e` under [`../../../../examples/upstream/`](../../../../examples/upstream/)) is an
airline customer-service conversation: a triage agent hands off to an FAQ agent
or a seat-booking agent, each user message is a `process_user_message` Update
with a validator, and the workflow continues-as-new when Temporal suggests it.

This directory runs it under Polyflow's guard. What changed, and what did not,
is declared in [`upstream.json`](upstream.json) and checked mechanically by
`node platform/examples/upstream/check.mjs`:

| File | Status |
|---|---|
| `workflows/customer_service_workflow.py` — the workflow, its Update handler and validator, continue-as-new | **byte-identical** |
| `customer_service.py` — agents, handoffs, context | changed in one place: the two inline `@function_tool`s are now tools of the Airline MCP server (`mcp_servers=[airline_tools()]`) |
| `run_worker.py` | released-SDK import path, the MCP server provider, and one line: `plugins=[PolyflowPlugin(level="guard", policy=..., sink=...)]` |
| `run_customer_service_client.py` | released-SDK import path only |
| `airline_server.py`, `policy.json`, `demo.py` | new |

## Why the tools moved

Upstream, `update_seat` runs inside the workflow and writes into the agent's run
context. Nothing crosses an activity boundary, so nothing outside the model can
see a seat change coming, let alone refuse it. This is also Temporal's own
guidance: a tool with an effect belongs in an activity. Served by the "Airline"
MCP server, every tool call is the activity `Airline-stateless-call-tool-v2`
carrying the tool's name, which the policy routes on:

```json
"routes": { "Airline-stateless-call-tool-v2": "0.tool_name" }
```

The record the sample's `update_seat` asserted on (the flight number the
handoff set) is now the booking the server holds, so the natural read is
`get_booking`, and the policy makes it a rule.

## The policy (`policy.json`)

| Effect | Kind / class |
|---|---|
| `invoke_model_activity` | `model` |
| `…:faq_lookup_tool` | `faq` |
| `…:get_booking` | `read`, labelled `reads-private` |
| `…:update_seat` | `booking`, **irreversible** |
| `…:cancel_booking` | not declared: routed and undeclared is always refused |

| Rule | What it says |
|---|---|
| `booking-after-lookup` (`requires-prior`) | a seat change needs a booking read that succeeded; each read licenses one change |
| `one-seat-change` (`at-most`, n=1) | one seat change per conversation; a second needs a person |
| `model-rate` (`rate`, 30/min) | a looping agent is stopped before it costs |

`unlabelled: deny` — anything the policy does not name is refused.

## Run it

```
cd platform/python
python examples/temporal_samples/customer_service/demo.py    # needs node and a Temporal dev-server download; no OpenAI key
```

The model is scripted with the SDK's own `ResponseBuilders`, so the conversation
is the one a hallucinating or looping agent has:

```
User: ABC123, seat 12A please.
Seat Booking Agent: Tool call output: … PolyflowDenied: booking-after-lookup: run 'read' and wait for it to
  succeed before 'booking' (each 'read' licenses one 'booking')
Seat Booking Agent: Tool call output: {"confirmation_number": "ABC123", … "flight_number": "FLT-512", "seat_number": "9C"}
Seat Booking Agent: Tool call output: Updated seat to 12A for confirmation number ABC123
User: Actually, make it 14C.
Seat Booking Agent: Tool call output: … one-seat-change: 'booking' may happen at most 1 time(s) in this run; it has happened 1
User: Then cancel the booking.
Seat Booking Agent: Tool call output: … activity 'Airline-stateless-call-tool-v2' is not declared in policy 'airline-seats'
```

The refusal is what the agent reads as the tool's output, with the rule and the
fix, so it re-plans (looks the booking up, then changes the seat). The seat is
changed exactly once. Every model call, every tool by its routed name, each
refusal with its witness and the closure are in one signed chain that the
TypeScript `polyflow verify` accepts:

```
  chain       intact through seq 91
  signatures  22 head(s), 22 trusted and anchored, signed through seq 91
  closure     present — the record is finished
  OK — consistent, closed and signed through its last event.
```

The test is `tests/test_sample_customer_service.py`.

## Two things to know

- **Escalation is a refusal in Python.** The Python plugin covers G0 and G1
  with no inbox: a rule that would *escalate* refuses instead, and the agent
  re-plans or tells the customer a person is needed (as above). Parking the
  call for a person is the TypeScript plugin's G1 (reference manual §2).
- **The SDK.** Upstream targets the unreleased `temporalio.openai_agents`
  module and the v2 `temporal_mcp_server` API; this port uses the released
  `temporalio.contrib.openai_agents` (1.33). When the v2 API ships, the route
  key is the one thing to re-check (`unlabelled: deny` will say so loudly).
