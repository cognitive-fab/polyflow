# 05 — Spike P0.6 / plan P7.4: G2 from Python on QuickJS

**Question.** Can the Python plugin host G2 (a certified SAM v2 machine) with no Node
runtime, with the TypeScript kernel's step semantics exactly, in a real sandbox, and within
the P0.6 budget (technical spec §13: "QuickJS-Wasm in the Python sandbox within NFR-2,
p50 step < 1 ms"; fallback "native acceptor code-gen")?

**Answer: yes.** QuickJS-NG compiled to WebAssembly runs under wasmtime, with no host
imports and a fuel budget. It reproduces the kernel host on all 512 operations of a new
cross-language corpus, and steps customer-brief at **p50 0.68–0.94 ms, p99 1.4–1.6 ms**
(measured across runs). One ~40% cost had to be moved out of the interpreter to get there:
the intent-id SHA-256 is now computed by the host (§5). A Python workflow drives the machine
through this host, and its history replays clean. The fallback, native acceptor code-gen, is
not needed.

Measured on 2026-09-22: Windows 11, Intel Core Ultra (Family 6 Model 170), Python 3.12.10,
wasmtime-py 49.0.0, quickjs (PyPI) 1.19.4, Node 24.12.0.

---

## 1. What was built

| File | What it is |
|---|---|
| `platform/python/polyflow_temporal/machine_host.py` | `bundle()` builds one closed script from a machine dir, and `QuickJSMachineHost` is the kernel's `createHost` surface in Python (`init`, `step`, `dry_run`, `check_snapshot`, `completion_action`, `is_terminal`, `keys`, `actions`). Also `register_machine` / `machine` (a registry workflow code reaches through the passthrough package). |
| `platform/python/polyflow_temporal/quickjs_engines.py` | Two engines behind one interface: `WasmQuickJS` (wasmtime, default) and `NativeQuickJS` (the `quickjs` PyPI binding, fallback). |
| `platform/python/polyflow_temporal/vendor/quickjs-wasi/` | `quickjs.wasm` (637 KB), its MIT `LICENSE`, and `PROVENANCE.txt` with the sha256 of the npm tarball and of the wasm. |
| `platform/conformance/generate-machine.mjs` → `machine.json` | 512 operations over customer-brief and refund-triage, plus three fixture machines under `conformance/machines/` (a template-literal require, a clock reader, and a mapper whose errors mention resources; P9 review QJ1–QJ3), computed by the TS kernel with `Date` as workflow time. |
| `platform/python/tests/test_quickjs_g2.py` (+ `g2_workflows.py`, `fixtures/escape_machine/`) | Conformance, sandbox, budget, latency, thread-safety and in-workflow replay tests. |
| `platform/python/pyproject.toml` | New extras: `g2 = ["wasmtime>=30"]` and `g2-native = ["quickjs>=1.19"]`. |

## 2. Engine: where a QuickJS-Wasm build comes from

| Source | Result |
|---|---|
| PyPI | `wasmtime` 49.0.0 (win_amd64 wheel) is on PyPI. **No QuickJS wasm build is on PyPI.** `quickjs-wasi`, `wasm-quickjs`, `quickjs-wasm`, `pyquickjs`, `javy` and `py-javy` do not exist there. `quickjs` (1.19.4) and `quickjs-ng` (0.16.2.1) exist, but only as native CPython extensions. |
| npm | **`quickjs-wasi@3.6.2`** (vercel-labs, MIT) is QuickJS-NG compiled as a WASI *reactor*. It exports the QuickJS C API plus `qjs_*` helpers and declares only 12 imports: 6 in `env` (`host_call`, `host_interrupt`, `host_promise_rejection`, `host_module_normalize`, `host_module_load`, `host_get_timezone_offset`) and 6 WASI (`clock_time_get`, `random_get`, `fd_write`, `fd_close`, `fd_fdstat_get`, `fd_seek`). `javy-cli` is deprecated in favour of GitHub releases. `quickjs-emscripten` needs Emscripten JS glue. |
| platform/node_modules | No QuickJS build is present, and no esbuild. webpack is present but not needed (§3). |

**Decision.** Use the `quickjs-wasi` wasm file only, none of its JS glue, and vendor it (with
its licence and hashes) so the tests run offline. Every one of the 12 imports is a stub defined
in Python (§4). The native `quickjs` binding stays as a fallback engine for installs without
wasmtime, and the conformance and sandbox tests run against both. **The vendored wasm is the one
decision this spike leaves open.** It is 637 KB checked into the Python package. The
alternatives are to fetch it at install time, pinned by sha256, or to build QuickJS-NG to
wasm32-wasi in our own CI.

## 3. Semantics: run the kernel host itself, not a port

`bundle()` puts into one script:

- `machine.cjs` and `effects.cjs`;
- `@cognitive-fab/sam-pattern`, resolved through `node_modules` the way Node does (its `dist/SAM.js` is a single UMD file);
- the kernel's own `machine-host.mjs` and `sha256.mjs`, byte for byte.

CommonJS files go into a `require` shim that only accepts the literal specifiers found at
bundle time. The machine's own files are scanned with the certificate's rule (SEC-CT1): every
`require`/`import` must name a literal, quoted or a template literal without `${}`, and anything
computed is a load error (P9 review QJ1). The two ES modules are rewritten to the same shape. The rewriter handles only
the forms they use, `import {..} from` and `export function|const`, and refuses anything else.
A `require` of `fs`, `node:*` or any other built-in, or of a file that does not exist, is a
load error. The bundle is about 106 KB, deterministic, and identified by its sha256
(`host.digest`). **Step kinds, `normalise`, effect/timer mapping, the poison rules and
`completionAction` are therefore the TS code itself, not a re-implementation.**

The glue exposes one function, `__polyflow(jsonRequest) -> jsonResponse`. Requests travel as
ASCII JSON, so lone surrogates survive the crossing.

A prelude makes the JS level deterministic, **with the TS workflow isolate's semantics** (P9
review QJ2):

- `Date.now()` and `new Date()` read **workflow time**: the `now` of the call, which is the same
  `now` the host is given for timers. In the Temporal TS isolate, `Date.now()` is the time of
  the workflow task, so a certified machine that reads the clock steps the same in both hosts.
  An earlier version made `Date.now()` throw. sam-pattern swallowed the throw and the step came
  back `unhandled`, silently, where TS accepted it.
- `Math.random()`, `setTimeout` and `setInterval` still throw. The call is also **marked**: the
  step (or dry run) poisons even when the machine or sam-pattern swallows the throw, so it is
  never a silent `unhandled`.
- This is still a divergence from TS: in the TS isolate `Math.random()` is a seeded,
  deterministic PRNG, so TS accepts the step. The clean fix is at admission (below).

`console` is a bounded in-guest buffer.

**Recommendation for the TS side.** Admission explores machines in Node, where the clock and
`Math.random` are real, so a machine that reads them is certified today. The certificate would
mean the same thing in every host if admission refused both. It could run the machine under a
`Date`/`Math.random` that throw, or scan for them the way SEC-CT1 scans requires. Until then,
the QuickJS host matches TS on the clock (workflow time) and poisons loudly on randomness.

## 4. Sandbox

| Property | wasm engine (default) | native engine (fallback) | Test |
|---|---|---|---|
| Host objects visible to machine code | none: `require`, `process`, `std`, `os`, `fetch`, `XMLHttpRequest`, `WebSocket`, `Deno`, `Bun`, `print`, `scriptArgs` are all `undefined` | same | `test_machine_code_sees_no_host_object` |
| Module loader | `import('os'/'std'/'fs'/...)` rejects: "could not load module" (`host_module_load` returns NULL) | same (the binding registers no module loader) | `test_the_engine_has_no_module_loader` |
| Dynamic `require('f'+'s')` | poisons: "require('fs') is not in the bundle" | same | `test_a_machine_that_reaches_out_poisons` |
| Files, sockets, processes | impossible: the guest's only imports are Python stubs. `fd_write` is swallowed, other fds return EBADF/ENOSYS, and there is no preopened directory, no socket API and no `host_call` target | the binding exposes no I/O, but the boundary is QuickJS's C code in-process | as above |
| Clock and entropy below JS | `clock_time_get` returns 0, `random_get` returns zero bytes. Two fresh guests produce the same `Math.random()` sequence | real `Date`/`Math.random` exist; only the JS prelude refuses them | `test_the_wasm_guest_has_no_clock_and_no_entropy` |
| Runaway loop | fuel exhausted, then a wasmtime `OUT_OF_FUEL` trap | CPU limit (`clock()`), then "interrupted" | `SPIN` |
| Runaway allocation | QuickJS memory limit or the store's memory cap; classified by the heap high-water signal | QuickJS memory limit; a caught out-of-memory is a **poison** (no engine signal) | `HOG` |
| Runaway recursion | wasm `STACK_OVERFLOW` trap | QuickJS "stack overflow", caught: a **poison** | `DEEP` |
| After any budget failure | `MachineBudgetExceeded` is raised, the engine is rebuilt (~40 ms) and the next step works | same (~15 ms) | `test_a_runaway_step_..._host_recovers` |

**Budget failures are decided by engine signals, never by message text** (P9 review QJ3). An
earlier version reclassified any poison whose text said "out of memory", "stack overflow" or
"interrupted" as a budget failure. A machine error like `ticket feed interrupted`, which TS
quarantines, became a task failure retried for ever. The signals are now:

- **Traps.** Wasm `OUT_OF_FUEL` and `STACK_OVERFLOW` traps, and the native binding's
  uncatchable interrupt.
- **A caught out-of-memory (wasm engine).** QuickJS lets code catch it, and the kernel host
  turns the throw into `{poisoned}`. So a poison counts as a budget failure only when the
  guest's linear memory grew past half its cap during that call. Wasm memory never shrinks,
  and the guest cannot fake that signal without actually allocating.
- **The native engine** has no such signal. There, a caught out-of-memory or stack overflow is
  a poison, bound to the fixed limits.

A budget failure is `MachineBudgetExceeded`: a task failure, which is retried, and never
recorded in the ledger.

**Fuel is stable, but not bit-exact.** The same step costs the same fuel within about 2%, but
not exactly. Cost depends slightly on the engine's heap history (allocator, GC), and running a
GC before each step did not make it exact. Consequences:

- a fuel budget cannot be a *deterministic* verdict;
- the default is set far above the need: 200 M fuel against about 2–4 M per step;
- exhaustion is treated as a resource failure, never as a verdict.

The native engine's `clock()` limit is wall-time-like on Windows, and is non-deterministic in
the same way.

**Thread safety.** The Python worker runs workflow activations on a thread pool, and a
registered host is shared across them. Neither a QuickJS context nor a wasmtime `Store` may be
entered by two threads at once, so each call holds a per-host lock
(`test_one_host_is_safe_across_worker_threads`: 8 threads × 32 replays). A worker that needs
parallel steps should register one host per thread, or a pool of hosts.

## 5. Conformance

`generate-machine.mjs` runs the TS kernel's `createHost` over:

- scripted cases: happy paths; rejections (stale completions, `already-started`,
  `nothing-to-stop`); unhandled actions; the empty brief denied; the review timer
  (`fireAt = now + 8 h`); `STOP`; `normalise` (an absent fact becomes `null`); unicode payloads;
  a lone surrogate in the run key, where the intent id is hashed over U+FFFD; `checkSnapshot`
  with valid, missing-key, extra-key, non-object and out-of-type states; `completionAction`
  for every effect kind × success / scalar success / permanent / exhausted, including
  refund-triage's `map` of `result.facts.*`;
- plus 12 seeded random walks of 10 steps per machine.

The corpus first totalled 356 operations: 62 accepted, 184 rejected and 26 unhandled steps,
3 dry runs, 8 snapshots, 36 completion actions, 4 terminal checks and 33 inits. The P9 review
(QJ1–QJ3) found machines it did not cover. Three fixtures and a random walk over the clock
reader bring it to 512.

The Python host reproduces every expected value exactly, as JSON. That covers step kind,
reason, `pre`/`post`, effects with intent ids and ordinals, timers, `cancelTimers`,
`terminal`, and snapshot and completion results. It holds for **both engines × both hashing
modes**.

**Host hashing.** Inside the wasm interpreter, the kernel's pure-JS `sha256hex` costs about
1.6 M fuel per intent id, roughly 40% of an accepted step. With `host_hash=True` (the default),
the kernel host still runs unchanged. The one difference: the `sha256hex` it imports records
the exact string the kernel built (`runKey|seq|kind|ordinal`) and returns a placeholder.
Python then fills in `sha256(input)[0:32]`, using the kernel's own UTF-8 rule: a lone
surrogate hashes as U+FFFD. The corpus pins the ids in both modes.

## 6. Latency

Per-step times, measured over 300 runs of customer-brief's 5-step happy path (1,500 steps each).
Runs vary about ±30% on this machine; the ranges are across 3 runs.

| Engine | Intent-id hashing | p50 | p99 | Fuel per step |
|---|---|---|---|---|
| **wasm (default)** | host | **0.68–0.94 ms** | 1.4–1.6 ms | 2.2–2.3 M |
| wasm | guest (pure JS) | 1.10–1.36 ms | 2.2–2.8 ms | 3.8–3.9 M (effect steps) |
| native | host | 0.46–0.63 ms | 1.0–1.8 ms | — |
| native | guest | 0.51–0.63 ms | 0.9–1.2 ms | — |
| Node, TS kernel host (JIT), for reference | in-process | 0.03 ms | 0.29 ms | — |

Where the wasm time goes:

- **The call boundary.** Each Python→wasm export call costs about 20 µs in wasmtime-py
  (ctypes), and memory reads and writes about 4–6 µs. A step makes 7 export calls through a
  persistent argument buffer, so the fixed round trip is about 0.35 ms.
- **The interpreted step.** Rehydration (`init` + `setState`), the SAM strict machinery,
  classification, projections and the mapper account for the rest.
- **Engine build.** Compiling the module takes about 0.6–0.8 s once per process (cached). A
  new instance plus loading the bundle takes about 40 ms. The native engine loads in about
  15 ms.

Against NFR-2 (≤ 5% of workflow-task time at p50): a Python workflow task costs milliseconds to
tens of milliseconds, and a G2 step adds about 0.7–0.9 ms of CPU inside it. That meets the
P0.6 target of p50 < 1 ms with the wasm engine and host hashing. It misses it with guest
hashing, and the native engine is comfortably inside it. The remaining headroom is in the
boundary: a single exported `step(ptr, len)` entry point in a custom wasm build would remove
most of the 0.35 ms.

## 7. In a Temporal workflow

`g2_workflows.MachineRun` is an ordinary Python workflow, in the sandbox with the
PolyflowPlugin. It looks the host up by name, calls `init` and `step` with
`run_key = workflow_id/run_id`, `seq`, and `now = workflow.time()`, and returns the trail. The
test runs it on a dev server, checks the step kinds, the final state and 32-hex intent ids, and
then **replays the history with `Replayer`: clean**. No file is read in workflow code. The host
is built at worker start-up and reached through `polyflow_temporal.machine_host`, which is a
sandbox passthrough module.

## 8. Gaps and next steps

1. **The bundle is a build artefact.** Today `bundle()` reads the kernel sources from
   `platform/packages/kernel/src` and sam-pattern from `node_modules`, which a pip-installed
   plugin does not have. Build the bundle when the machine is certified, and put its digest in
   the certificate. The Python worker then loads the bundle file and checks the digest. No
   kernel checkout is needed at run time.
2. **G2 wiring.** This spike delivers the evaluator. A Python `GovernedWorkflow` still has to
   be built:
   - effects to activities;
   - timers to `workflow.sleep`;
   - completion actions;
   - Update validators through `dry_run`;
   - the ledger events the TS governed workflow writes.
3. **Parent/child intents** (`spawnChild`, `signalChild`) poison, exactly as in the TS host
   ("not supported by this host yet").
4. **Wasm provenance.** Decide between vendoring, a pinned download, or our own QuickJS-NG
   wasm32-wasi build (§2).
5. **Faster boundary** if needed: a custom wasm export that takes the request buffer and
   returns the response buffer in one call. Separately, a snapshot of an initialised instance
   (`quickjs-wasi` supports snapshot/restore) would cut the ~40 ms engine rebuild after a
   budget failure.
