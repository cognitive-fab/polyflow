"""P9 review — G2 from Python on QuickJS (plan P7.4). The spike doc says the
QuickJS host runs "the TS code itself, not a re-implementation", so a machine
the TypeScript worker certifies and runs must step the same way here. Each
test fails today for the reason in its message. See
docs/platform/reviews/P9-review.md (QJ1-QJ3).
"""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

try:
    import wasmtime  # noqa: F401
except ImportError:
    try:
        import quickjs  # noqa: F401
    except ImportError:
        pytest.skip("the QuickJS host needs `wasmtime` or `quickjs`", allow_module_level=True)

from polyflow_temporal.machine_host import MachineLoadError, QuickJSMachineHost  # noqa: E402

PLATFORM = Path(__file__).resolve().parents[2]
EXAMPLES = PLATFORM / "examples"
KERNEL = (PLATFORM / "packages" / "kernel" / "src" / "index.mjs").as_uri()

TS_STEP = """
import { createHost } from '%s';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const dir = process.env.MACHINE_DIR;
const req = createRequire(dir + '/x.cjs');
const json = (f) => JSON.parse(readFileSync(dir + '/' + f, 'utf-8'));
const host = createHost({ module: req(dir + '/machine.cjs'), contract: json('contract.json'), mapper: req(dir + '/effects.cjs').effects, manifest: json('effects.manifest.json') });
const r = host.step(host.init(), 'START', {}, { runKey: 'k', seq: 1, now: 0 });
console.log(JSON.stringify({ stepKind: r.stepKind ?? (r.poisoned ? 'poisoned' : null), reason: r.poisoned ?? r.reason ?? null }));
""" % KERNEL


@pytest.fixture
def machine_copy():
    made = []

    def make(edit_from: str, edit_to: str, file: str = "machine.cjs") -> Path:
        # Under examples/, so sam-pattern resolves through platform/node_modules as it does for the originals.
        d = Path(tempfile.mkdtemp(prefix=".tmp-review-p9-py-", dir=EXAMPLES))
        made.append(d)
        shutil.copytree(EXAMPLES / "customer-brief", d, dirs_exist_ok=True)
        f = d / file
        src = f.read_text(encoding="utf-8")
        assert edit_from in src, f"fixture drift: {edit_from!r} not in {f}"
        f.write_text(src.replace(edit_from, edit_to, 1), encoding="utf-8")
        return d

    yield make
    for d in made:
        shutil.rmtree(d, ignore_errors=True)


def ts_step(d: Path) -> dict:
    out = subprocess.run(["node", "--input-type=module", "-e", TS_STEP], capture_output=True, text=True, env={**os.environ, "MACHINE_DIR": str(d).replace("\\", "/")})
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def py_step(d: Path) -> dict:
    host = QuickJSMachineHost(d)
    r = host.step(host.init(), "START", {}, run_key="k", seq=1, now=0)
    return {"stepKind": r.get("stepKind") or ("poisoned" if r.get("poisoned") else None), "reason": r.get("poisoned") or r.get("reason")}


def test_qj1_a_require_the_ts_certificate_accepts_loads_in_the_quickjs_host(machine_copy):
    # certificates.mjs (SEC-CT1 fix) certifies `require(`...`)` without ${} as a
    # literal, and webpack bundles it; bundle() matches quotes only.
    d = machine_copy("require('@cognitive-fab/sam-pattern')", "require(`@cognitive-fab/sam-pattern`)")
    ts = ts_step(d)
    assert ts["stepKind"] == "accepted", f"control: the TS host steps it: {ts}"
    try:
        py = py_step(d)
    except MachineLoadError as err:
        pytest.fail(f"QJ1: the TS kernel host loads and steps this machine ({ts}); the QuickJS host refuses to load it: {err}")
    assert py == ts, f"QJ1: TS {ts} vs QuickJS {py}"


def test_qj2_a_machine_that_reads_the_clock_steps_the_same_in_both_hosts(machine_copy):
    # In the TS workflow isolate Date.now() is workflow time (deterministic), and
    # admission explores the machine in Node with a real clock: the machine is
    # certified and runs. The QuickJS prelude makes Date.now() throw, and
    # sam-pattern swallows the throw: the step comes back 'unhandled', silently.
    d = machine_copy("if (model.briefState !== 'idle') return reject('already-started');",
                     "if (model.briefState !== 'idle' || Date.now() < 0) return reject('already-started');")
    ts = ts_step(d)
    assert ts["stepKind"] == "accepted", f"control: the TS host steps it: {ts}"
    py = py_step(d)
    assert py == ts, f"QJ2: the same certified machine is accepted by the TS host and {py['stepKind']} by the QuickJS host ({py['reason']})"


def test_qj3_a_machine_defect_is_a_poison_in_both_hosts_not_a_retried_resource_failure(machine_copy):
    # The host reclassifies any poison whose TEXT matches /out of memory|stack
    # overflow|interrupted/ as MachineBudgetExceeded: a task failure, retried
    # for ever, instead of the quarantine the TS host gives the same defect.
    d = machine_copy("if (entered('gathering')) {", "if (entered('gathering')) { throw new Error('ticket feed interrupted');", file="effects.cjs")
    ts = ts_step(d)
    assert ts["stepKind"] == "poisoned", f"control: the TS host poisons (quarantines) it: {ts}"
    try:
        py = py_step(d)
    except Exception as err:  # noqa: BLE001
        pytest.fail(f"QJ3: the TS host quarantines this run ({ts['reason']}); the QuickJS host raises {type(err).__name__} ({err}), which the worker retries as a task failure for ever")
    assert py["stepKind"] == "poisoned", f"QJ3: TS {ts} vs QuickJS {py}"
