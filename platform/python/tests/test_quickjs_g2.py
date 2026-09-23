"""G2 from Python (plan P7.4, spike P0.6): a certified SAM v2 machine in QuickJS.

1. conformance: the QuickJS host reproduces the TypeScript kernel host's
   results over conformance/machine.json exactly (step kinds, reasons, states,
   effects and intent ids, timers, snapshots, completion actions);
2. sandbox: machine code reaches no host object, no file, no network, no
   clock and no randomness, and a runaway loop or allocation is stopped by the
   CPU / memory budget, after which the host still works;
3. latency: per-step p50 / p99, printed (see docs/platform/research/05-quickjs-g2-spike.md);
4. in a workflow: a Python workflow steps the machine, and its history replays.
"""

import json
import statistics
import time
import uuid
from pathlib import Path

import pytest

ENGINES = []
try:
    import wasmtime  # noqa: F401
    ENGINES.append("wasm")
except ImportError:
    pass
try:
    import quickjs  # noqa: F401
    ENGINES.append("native")
except ImportError:
    pass
if not ENGINES:
    pytest.skip("the QuickJS host needs `wasmtime` (preferred) or `quickjs`", allow_module_level=True)

from polyflow_temporal.machine_host import (  # noqa: E402
    MachineBudgetExceeded, MachineLoadError, QuickJSMachineHost, bundle, register_machine,
)

PLATFORM = Path(__file__).resolve().parents[2]
EXAMPLES = PLATFORM / "examples"
CORPUS = json.loads((PLATFORM / "conformance" / "machine.json").read_text(encoding="utf-8"))
ESCAPE = Path(__file__).parent / "fixtures" / "escape_machine"


@pytest.fixture(scope="module", params=[(e, h) for e in ENGINES for h in (True, False)],
                ids=lambda p: f"{p[0]}-{'host' if p[1] else 'guest'}-hash")
def hosts(request):
    engine, host_hash = request.param
    return {name: QuickJSMachineHost(PLATFORM / CORPUS["dirs"][name], engine=engine, host_hash=host_hash) for name in CORPUS["machines"]}


def _replay(host, ops):
    state = None
    for i, op in enumerate(ops):
        kind = op["op"]
        data = json.loads(op["data"]) if "data" in op else ...
        if kind == "init":
            got = host.init(now=op.get("now", 0))
            state = got
        elif kind == "step":
            got = host.step(op.get("state", state), op["action"], data, run_key=op.get("runKey", "run-1"), seq=op.get("seq", 0), now=op.get("now", 0))
            if "poisoned" not in got:
                state = got["post"]
        elif kind == "dryRun":
            got = host.dry_run(op.get("state", state), op["action"], data, now=op.get("now", 0))
        elif kind == "checkSnapshot":
            got = host.check_snapshot(op["snap"], now=op.get("now", 0))
        elif kind == "completionAction":
            got = host.completion_action(op["kind"], op["outcome"], result=op.get("result"), message=op.get("message"))
        elif kind == "isTerminal":
            got = host.is_terminal(op.get("state", state))
        yield i, op, got


@pytest.mark.parametrize("machine,case", [(m, c) for m, cs in CORPUS["machines"].items() for c in cs],
                         ids=lambda v: v if isinstance(v, str) else v["name"])
def test_the_quickjs_host_steps_like_the_typescript_kernel(hosts, machine, case):
    for i, op, got in _replay(hosts[machine], case["ops"]):
        assert got == op["expect"], f"{machine} / {case['name']} / op {i} ({op['op']} {op.get('action', op.get('kind', ''))})"


def test_the_corpus_covers_every_step_kind_and_intents():
    seen = {op["expect"].get("stepKind") for cs in CORPUS["machines"].values() for c in cs for op in c["ops"]
            if op["op"] == "step"}
    assert {"accepted", "rejected", "unhandled"} <= seen
    intents = [e for cs in CORPUS["machines"].values() for c in cs for op in c["ops"] if op["op"] == "step" for e in op["expect"].get("effects", [])]
    timers = [t for cs in CORPUS["machines"].values() for c in cs for op in c["ops"] if op["op"] == "step" for t in op["expect"].get("timers", [])]
    assert len(intents) > 10 and timers


def test_the_bundle_is_closed_and_identified(hosts):
    host_hash = "if (true) {\n  // The kernel host's own code" in hosts["customer-brief"].source
    b = bundle(EXAMPLES / "customer-brief", host_hash=host_hash)
    assert b == hosts["customer-brief"].source, "bundling is deterministic: the digest names what runs"
    assert hosts["customer-brief"].digest != hosts["refund-triage"].digest


# ---- sandbox ----------------------------------------------------------------------

@pytest.fixture(params=ENGINES)
def hostile(request):
    return QuickJSMachineHost(ESCAPE, engine=request.param, fuel=50_000_000, time_limit_s=0.2, memory_limit=32 * 1024 * 1024)


def test_machine_code_sees_no_host_object(hostile):
    r = hostile.step(hostile.init(), "PROBE", {})
    assert r["stepKind"] == "accepted"
    assert all(pair.endswith(":undefined") for pair in r["post"]["phase"].split(",")), r["post"]["phase"]


@pytest.mark.parametrize("action,why", [
    ("DYNAMIC_REQUIRE", "require('fs') is not in the bundle"),
    ("RANDOM", "a machine has no randomness"),
    ("TIMER", "a machine has no timers"),
    # sam-pattern (or the machine) may swallow the throw: the call still poisons (P9 QJ2).
    ("SWALLOWED_RANDOM", "a machine has no randomness"),
])
def test_a_machine_that_reaches_out_poisons(hostile, action, why):
    r = hostile.step(hostile.init(), action, {})
    assert "poisoned" in r and why in r["poisoned"], r
    assert hostile.dry_run(hostile.init(), action, {}) == {"stepKind": "poisoned", "reason": r["poisoned"]}


@pytest.mark.parametrize("action", ["CLOCK", "NEW_DATE"])
def test_the_clock_is_workflow_time_as_in_the_ts_isolate(hostile, action):
    # P9 QJ2: in the TS workflow isolate Date.now() is workflow time; the host passes it as `now`.
    for now in (0, 1_700_000_000_123):
        r = hostile.step(hostile.init(), action, {}, now=now)
        assert r["stepKind"] == "accepted" and r["post"]["phase"] == str(now), r


@pytest.mark.parametrize("module", ["os", "std", "fs", "./machine.cjs"])
def test_the_engine_has_no_module_loader(hostile, module):
    # QuickJS's std/os modules (files, processes, sockets) are never registered.
    hostile.eval_untrusted(f"globalThis.r = 'pending'; import({json.dumps(module)}).then(() => {{ globalThis.r = 'loaded'; }}, (e) => {{ globalThis.r = 'refused: ' + e; }}); 1")
    assert hostile.eval_untrusted("globalThis.r").startswith("refused: ReferenceError: could not load module")


def test_the_wasm_guest_has_no_clock_and_no_entropy():
    if "wasm" not in ENGINES:
        pytest.skip("wasmtime is not installed")
    from polyflow_temporal.quickjs_engines import WasmQuickJS
    a, b = (WasmQuickJS(fuel=10_000_000, memory_limit=16 << 20, stack_bytes=1 << 20) for _ in range(2))
    # Below the JS-level refusals, the guest's own clock and entropy are stubs: time 0, bytes 0.
    assert a.eval("Date.now()") == b.eval("Date.now()") == "0"
    assert a.eval("[Math.random(), Math.random()].join()") == b.eval("[Math.random(), Math.random()].join()")


@pytest.mark.parametrize("spec", ["fs", "node:child_process", "./nowhere.cjs", "not-a-package"])
def test_a_machine_requiring_a_host_module_does_not_load(tmp_path, spec):
    (tmp_path / "machine.cjs").write_text(f"module.exports = require('{spec}');\n")
    (tmp_path / "contract.json").write_text("{}")
    with pytest.raises(MachineLoadError):
        bundle(tmp_path)


@pytest.mark.parametrize("action", ["SPIN", "HOG", "DEEP"])
def test_a_runaway_step_is_stopped_by_its_budget_and_the_host_recovers(hostile, action):
    t = time.perf_counter()
    if hostile.engine == "native" and action != "SPIN":
        # The native binding gives no engine signal for a CAUGHT out-of-memory or
        # stack overflow, and budgets are never decided from message text (P9 QJ3):
        # it is a poison there, bound to the fixed limits. The wasm engine traps.
        r = hostile.step(hostile.init(), action, {})
        assert "poisoned" in r, r
    else:
        with pytest.raises(MachineBudgetExceeded):
            hostile.step(hostile.init(), action, {})
    assert time.perf_counter() - t < 5
    r = hostile.step(hostile.init(), "OK", {})
    assert r["stepKind"] == "accepted" and r["post"] == {"phase": "done"} and r["terminal"] is True


# ---- latency ------------------------------------------------------------------------

def test_per_step_latency(hosts, capsys):
    host = hosts["customer-brief"]
    script = [("START", {}), ("TICKETS_READY", {"count": 3}), ("DRAFT_READY", {}), ("APPROVED", {}), ("POST_DONE", {})]
    samples = []
    for run in range(300):
        state = host.init()
        for seq, (action, data) in enumerate(script, start=1):
            t = time.perf_counter_ns()
            r = host.step(state, action, data, run_key=f"r{run}", seq=seq, now=seq * 1000)
            samples.append(time.perf_counter_ns() - t)
            state = r["post"]
    samples.sort()
    p50 = samples[len(samples) // 2] / 1e6
    p99 = samples[int(len(samples) * 0.99)] / 1e6
    with capsys.disabled():
        print(f"\n[quickjs-g2] {host.engine}: customer-brief, {len(samples)} steps: p50 {p50:.3f} ms, p99 {p99:.3f} ms, "
              f"mean {statistics.mean(samples) / 1e6:.3f} ms")
    assert p99 < 50, "a step is a pure function over a small state: it should cost well under a workflow task"
    if host.engine == "wasm":
        fuel, state = [], host.init()
        for seq, (action, data) in enumerate(script, start=1):
            state = host.step(state, action, data, run_key="fuel", seq=seq)["post"]
            fuel.append(host._js.fuel_used())
        again, state = [], host.init()
        for seq, (action, data) in enumerate(script, start=1):
            state = host.step(state, action, data, run_key="fuel", seq=seq)["post"]
            again.append(host._js.fuel_used())
        # Fuel counts instructions, so a step's cost is stable, but not bit-exact: it
        # depends a little on the engine's heap history (allocator, GC). Hence a budget
        # far above the need, and exhaustion is a resource failure, never a verdict.
        assert all(abs(a - b) <= 0.05 * a for a, b in zip(fuel, again)), (fuel, again)
        assert max(fuel) * 20 < host.fuel
        with capsys.disabled():
            print(f"[quickjs-g2] wasm fuel per call: {fuel}")


# ---- in a workflow --------------------------------------------------------------------

async def test_a_python_workflow_steps_the_machine_and_replays():
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Replayer, Worker

    from g2_workflows import MachineRun
    from polyflow_temporal.plugin import MemorySink, PolyflowPlugin

    register_machine("customer-brief", QuickJSMachineHost(EXAMPLES / "customer-brief"))  # the default engine
    script = [["START", {}], ["TICKETS_READY", {"count": 3}], ["APPROVED", {}], ["DRAFT_READY", {}], ["APPROVED", {}], ["POST_DONE", {}]]
    env = await WorkflowEnvironment.start_local()
    try:
        tq, wid = f"g2-{uuid.uuid4()}", f"g2-{uuid.uuid4()}"
        async with Worker(env.client, task_queue=tq, workflows=[MachineRun], plugins=[PolyflowPlugin(sink=MemorySink())], max_cached_workflows=0):
            trail = await env.client.execute_workflow(MachineRun.run, args=["customer-brief", script], id=wid, task_queue=tq)
        assert [t["stepKind"] for t in trail] == ["accepted", "accepted", "rejected", "accepted", "accepted", "accepted"]
        assert trail[-1]["state"]["briefState"] == "posted"
        assert all(len(i) == 32 for t in trail for i in t["intents"])
        history = await env.client.get_workflow_handle(wid).fetch_history()
        await Replayer(workflows=[MachineRun], plugins=[PolyflowPlugin(sink=MemorySink())]).replay_workflow(history)
    finally:
        await env.shutdown()


def test_one_host_is_safe_across_worker_threads(hosts):
    # The Python worker runs workflow activations on a thread pool; they share a registered host.
    from concurrent.futures import ThreadPoolExecutor
    host = hosts["refund-triage"]
    expected = CORPUS["machines"]["refund-triage"][0]["ops"]

    def one(_):
        return [got == op["expect"] for _, op, got in _replay(host, expected)]
    with ThreadPoolExecutor(8) as pool:
        assert all(all(r) for r in pool.map(one, range(32)))


@pytest.mark.parametrize("call", ["require(`./${name}.cjs`)", "require(name)", "require('./a' + '.cjs')", "import(`./x.mjs`.trim())"])
def test_a_computed_require_is_refused_at_bundle_time_as_by_the_certificate(tmp_path, call):
    # P9 QJ1: the certificate's scanner (SEC-CT1). Literals, quoted or template without ${}, load; nothing else.
    (tmp_path / "machine.cjs").write_text(f"const name = 'x';\nmodule.exports = {call};\n")
    (tmp_path / "contract.json").write_text("{}")
    with pytest.raises(MachineLoadError, match="does not name a literal path"):
        bundle(tmp_path)


def test_a_machine_error_that_mentions_a_resource_is_still_a_poison():
    # P9 QJ3: budgets are decided by an engine signal, never by message text.
    host = QuickJSMachineHost(PLATFORM / CORPUS["dirs"]["mapper-throws"])
    r = host.step(host.init(), "START", {"fail": True}, run_key="k", seq=1)
    assert r == {"poisoned": "effect mapper threw: ticket feed interrupted"}
