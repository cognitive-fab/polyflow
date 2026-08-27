# polycrew C0 — implementation plan

The MVP: several Claude Code CLI sessions working one run at the same time,
without stepping on each other, and a page where a person can watch it. One
host, one tool vocabulary. Spec: [`polycrew-spec.html`](polycrew-spec.html),
milestone C0.

## Three decisions, settled

**C0 does not touch polyrun.** MA-14 wants `actor` as a column on `pr_journal`,
which is polyrun's schema. Instead polycrew keeps `(instance, seq) → actor` in
its own store and the dashboard joins. The polyrun change becomes separate,
later work. C0 stays inside two repositories we control.

**polycrew gets its own SQLite file**, beside polyflow's, holding orders and
actors — no coupling to polyrun's schema at all. If a crash loses an order row,
the effect lease expires, the handler re-runs and recreates it. The two stores
cannot drift permanently.

**Everything is testable over stdio without a model.** `test/mcp.test.mjs`
already spawns the server and speaks JSON-RPC to it; spawning three is the same
trick. Only step 8 needs real `claude` sessions.

## Steps

Each is one commit with a test that proves it, ordered so nothing is built on
an unverified assumption.

| # | What | Test |
|---|---|---|
| **0** | **The seam, in polyflow.** `Polyflow` takes an injected broker; `makeTools(pf, extra)` appends. | A substitute broker drives a run end to end; extra tools reach the surface; a name collision is refused. |
| 1 | **polycrew scaffold.** New repo, polyflow as a pinned tarball dependency, `bin/polycrew.mjs` behaving exactly like `polyflow-mcp.mjs`. | The six polyflow tools work through polycrew's binary — the dependency direction holds before anything is added. |
| 2 | **Identity and registry.** Mint `{agent}/{8 hex}` at boot; write `~/.polyflow/instances.json` (area, port, store, workflows, pid, actor, started); reap dead pids on read. | Two processes on one area get distinct ids and both appear; kill one, its entry is reaped. |
| 3 | **The order store.** `pf_orders` and a `StoreBroker` satisfying the broker contract, backed by the table. | Unit only, no MCP, no HTTP: claim, double-claim → `claimed-by-other`, lease expiry frees it, report by a non-holder → `not-your-order`. |
| 4 | **Election and proxy.** Boot tries to bind the derived port. Bound → broker: open store, run engine, serve HTTP. Failed → proxy: serve stdio, forward `tools/call` to the broker. | Three processes on one area, exactly one binds; a call through a proxy returns the broker's answer; kill the broker and the next proxied call elects a new one. |
| 5 | **The crew tools.** `workflow_next`, `workflow_claim`; `workflow_report` enforces the claim. Actor stamped by the server, absent from every schema. | Two sessions, one run, several orders: each completes exactly once, and neither session ever supplied an actor. |
| 6 | **Actor attribution.** Record `(instance, seq) → actor` on each accepted step; `workflow_journal` joins it. | A journal read names the actor behind each step; a timer step reads as `system/timer`. |
| 7 | **The dashboard.** `GET /dashboard`: open orders with claimant and age, runs in flight, timers armed, leases past due. Read-only, loopback-bound. | An HTTP fetch returns the same facts as `workflow_progress`; a non-loopback bind is refused. |
| 8 | **Acceptance.** Two real `claude` sessions in one project on a workflow with several parallel orders. | One completion per order, two ids neither chose; kill one mid-order and the other takes it — in the journal and on the page. |

## Where the risk is

**Step 4.** Port-binding election is simple; its failure modes are timing — a
proxy whose broker dies mid-call, two processes racing to bind after a death, a
stale registry entry pointing at a port someone else now holds. Budget more
test time here than anywhere else, and make the client's retry-then-elect path
explicit rather than incidental.

**Step 3** is where the semantics get decided. Over-test it rather than
discover a claim race through a flaky acceptance run.

Steps 0–1 are small and mechanical. Steps 5–7 are largely wiring once 3 and 4
hold.

## Status

- [x] **0 — the seam.** `src/broker.mjs` names the contract (`handler`, `open`,
      `orderById`, `issued`, `report`, `abort`); `Polyflow` takes `broker`;
      `makeTools(pf, extra)` appends and refuses a collision.
      `test/seam.test.mjs` proves both halves. 21 tests green.
- [x] **1 — scaffold.** [`cognitive-fab/polycrew`](https://github.com/cognitive-fab/polycrew),
      polyflow pinned to a commit tarball, the six tools served through
      polyflow's own `serve()`. Roles read from `POLYCREW_ROLES`, and a test
      asserts no tool schema accepts `roles` or `actor`. The library defaults
      to the demo one polyflow ships. 3 tests, over stdio, no model.
      Polyflow gained `src/index.mjs` and an `exports` map on the way: the
      boundary is a door now, not a set of deep paths.
- [x] **2 — identity and registry.** Actor ids minted per process; the
      registry is a *directory* (`~/.polyflow/registry/<crew>/<actor>.json`),
      one file per session, not the single `instances.json` the spec asked for
      — concurrent sessions would lose entries to read-modify-write with no
      error anywhere. Dead pids and torn files reaped on read. `portFor(area)`
      derives the broker port. 11 tests.
- [x] **3 — the order store.** `StoreBroker` satisfies the contract with
      orders in SQLite, and adds `offers`, `claim`, `renew`, `sweep`. Two
      leases kept apart: polyrun's worker lease on the effect, the actor's
      claim on the order. 14 unit tests on a fake clock cover claim
      arbitration, lapse-and-re-offer, report-after-losing-the-lease,
      double-settle, role refusal, and a polyrun re-offer arriving as the same
      order at a higher attempt. 25 tests in polycrew.
- [x] **4 — election and proxy.** Binding the crew's port is the election;
      the winner opens the store and runs the engine, the losers forward over
      loopback and take over when it dies. Three corrections came out of real
      processes rather than design: a *bound* port is not a *ready* broker, so
      `/rpc` answers 503 until the engine is up and callers retry; a *failed
      bind* is not proof a broker is there, so a port counts as taken only when
      something answers `/health`; and consecutive candidate ports are not
      enough, because this machine refuses a contiguous 4,000-port block with
      nothing listening on it (Windows reserves ranges that
      `netsh excludedportrange` does not always list). Candidates now step by a
      stride coprime with the range, so every session of a crew still walks the
      same list in the same order and the crew converges on one port together.
      5 end-to-end tests with real processes: three racing for one port, a call
      crossing the seam, two sessions deriving one run through it, a SIGKILLed
      broker succeeded by exactly one proxy with the run and its open orders
      intact, and a failed tool that must not read as an election. 30 tests.
- [ ] 5 — the crew tools
- [ ] 6 — actor attribution
- [ ] 7 — the dashboard
- [ ] 8 — acceptance
