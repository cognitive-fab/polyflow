"""G2 from Python: a certified SAM v2 machine, hosted in QuickJS (plan P7.4, spike P0.6).

A machine is JavaScript (``machine.cjs`` on ``@cognitive-fab/sam-pattern``,
``effects.cjs``). The Python plugin cannot run Node, so it evaluates the
machine in an embedded QuickJS engine, together with the TypeScript kernel's
OWN machine host (``packages/kernel/src/machine-host.mjs``, with its
``sha256.mjs``): the step semantics (accepted | rejected | unhandled, the
normalise of absent to null, the effect/timer mapping, the intent ids
``sha256(runKey|seq|kind|ordinal)[0:32]``, the poison rules) are not ported,
they are the same code. platform/conformance/machine.json pins them.

The bundle is built here, in Python, from the files: no Node, no bundler.
CommonJS modules are wrapped in a ``require`` shim; the two kernel ES modules
are rewritten to the same shape (only the ``import {..} from`` and
``export function|const`` forms they use; anything else is refused). Every
``require`` must be a string literal naming a relative file or an installed
package: the bundle is closed, and its digest identifies exactly what runs.

Sandbox (see quickjs_engines.py). The default engine is QuickJS-NG compiled
to WebAssembly, under wasmtime, with every import stubbed (no clock, no
entropy, no files, no sockets, no module loader, no host functions) and a
FUEL budget per call; the fallback is the ``quickjs`` PyPI binding (native,
CPU-time budget). Either way the JS context has no ``std``/``os`` modules, no
``require``, no I/O, and no Python callables. Exhausting fuel / CPU, memory
or stack raises :class:`MachineBudgetExceeded` and the engine is rebuilt
(QuickJS is not trusted after an out-of-memory). The machine
reads WORKFLOW time from ``Date.now()`` / ``new Date()`` (the call's ``now``,
as the TS workflow isolate gives it), and ``Math.random`` and timers poison
the call, even if the machine swallows the throw.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from pathlib import Path
from typing import Any

from .quickjs_engines import VENDORED_WASM, EngineBudget, EngineError, NativeQuickJS, WasmQuickJS

PLATFORM = Path(__file__).resolve().parents[2]
KERNEL_SRC = PLATFORM / "packages" / "kernel" / "src"

DEFAULT_TIME_LIMIT_S = 0.25
DEFAULT_FUEL = 200_000_000  # wasm fuel per call; a customer-brief step uses ~2-4M
DEFAULT_MEMORY_LIMIT = 64 * 1024 * 1024
LOAD_TIME_LIMIT_S = 5.0
MAX_STACK_BYTES = 1024 * 1024


class MachineBudgetExceeded(RuntimeError):
    """A step ran out of fuel / CPU time, memory or stack. Not a verdict: a resource
    failure, which a workflow treats as a task failure (retried), never as a step result."""


class MachineLoadError(ValueError):
    pass


# ---- bundling -----------------------------------------------------------------

# The certificate's scanner (temporal/src/certificates.mjs, SEC-CT1): every
# require/import in a machine's own files must name a LITERAL, quoted or a
# template literal without ${}; anything computed is refused at bundle time.
_CALL = re.compile(r"\b(require|import)\s*\(\s*([^)]*?)\s*\)")
_LITERAL = re.compile(r"""^(['"])([^'"`$]*)\1$|^`([^`$]*)`$""")
_IMPORT = re.compile(r"""^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$""", re.M)
_NODE_BUILTINS = {"fs", "path", "os", "crypto", "child_process", "net", "http", "https", "worker_threads", "vm", "process"}
_EXPORT = re.compile(r"^export\s+(function|const|let|class)\s+([A-Za-z_$][\w$]*)", re.M)


def _package_main(start: Path, name: str) -> Path:
    """Node's resolution for a bare package name: walk up node_modules, read `main`."""
    for d in [start, *start.parents]:
        pkg = d / "node_modules" / name
        if (pkg / "package.json").exists():
            main = json.loads((pkg / "package.json").read_text(encoding="utf-8")).get("main", "index.js")
            f = (pkg / main).resolve()
            return f if f.suffix else f.with_suffix(".js")
    raise MachineLoadError(f"package '{name}' is not installed under {start} or any parent")


def _resolve(spec: str, from_file: Path) -> Path:
    if spec.startswith("./") or spec.startswith("../"):
        f = (from_file.parent / spec).resolve()
        for cand in (f, f.with_suffix(f.suffix + ".js"), f.with_suffix(".js"), f.with_suffix(".cjs")):
            if cand.is_file():
                return cand
        raise MachineLoadError(f"{from_file.name}: cannot resolve '{spec}'")
    if spec.startswith("node:") or spec in _NODE_BUILTINS:
        raise MachineLoadError(f"{from_file.name}: a machine may not require '{spec}' (no host modules in a machine)")
    return _package_main(from_file.parent, spec)


def _is_machine_file(file: Path) -> bool:
    return "node_modules" not in file.parts


def _requires(src: str, file: Path, *, strict: bool) -> list:
    """The specifiers a CommonJS file requires, in order. In a machine's own files
    (strict) every require/import call must name a literal, as the certificate
    demands; a library is scanned for literal requires only."""
    out = []
    for m in _CALL.finditer(src):
        lit = _LITERAL.match(m.group(2))
        if lit is None:
            if strict:
                raise MachineLoadError(f"{file.name}: {m.group(1)}({m.group(2)[:60]}) does not name a literal path: "
                                       "a certificate cannot cover code chosen at run time")
            continue
        if m.group(1) == "require":
            spec = lit.group(2) if lit.group(2) is not None else lit.group(3)
            if spec not in out:
                out.append(spec)
    return out


def _esm_to_function(src: str, file: Path, ids: dict) -> str:
    """The two forms the kernel's modules use, and nothing else."""
    def imp(m):
        target = _resolve(m.group(2), file)
        return f"const {{{m.group(1)}}} = __esm({json.dumps(ids.setdefault(str(target), f'm{len(ids)}'))});"
    body = _IMPORT.sub(imp, src)
    names = [m.group(2) for m in _EXPORT.finditer(body)]
    body = _EXPORT.sub(lambda m: f"{m.group(1)} {m.group(2)}", body)
    if re.search(r"^\s*(import|export)\b", body, re.M):
        raise MachineLoadError(f"{file.name}: an ES module form this bundler does not handle")
    return body + f"\nreturn {{ {', '.join(names)} }};"


def bundle(machine_dir: str | Path, *, kernel_src: str | Path = KERNEL_SRC, host_hash: bool = True) -> str:
    """One closed script: the machine, its mapper, sam-pattern, and the kernel host.

    ``host_hash``: the kernel host derives intent ids with its pure-JS SHA-256,
    about 40% of an accepted step inside the wasm interpreter. With host_hash
    the SAME host code runs, but its ``sha256hex`` records the exact input
    string and returns a placeholder; the id is then computed in Python from
    that input (``sha256(input)[0:32]``, the kernel's own derivation).
    Conformance is checked in both modes.
    """
    machine_dir = Path(machine_dir).resolve()
    kernel_src = Path(kernel_src).resolve()
    ids: dict = {}   # file -> module id
    code: dict = {}  # module id -> its definition, in load order

    def add_cjs(file: Path) -> str:
        key = str(file)
        if key in ids and ids[key] in code:
            return ids[key]
        mid = ids.setdefault(key, f"m{len(ids)}")
        code[mid] = None  # seen (a require cycle resolves to the same id)
        src = file.read_text(encoding="utf-8")
        mapping = {spec: add_cjs(_resolve(spec, file)) for spec in _requires(src, file, strict=_is_machine_file(file))}
        code[mid] = f"__cjs({json.dumps(mid)}, {json.dumps(mapping)}, function (module, exports, require) {{\n{src}\n}});"
        return mid

    def add_esm(file: Path) -> str:
        key = str(file)
        if key in ids and ids[key] in code:
            return ids[key]
        mid = ids.setdefault(key, f"m{len(ids)}")
        code[mid] = None
        src = file.read_text(encoding="utf-8")
        for m in _IMPORT.finditer(src):
            add_esm(_resolve(m.group(2), file))
        code[mid] = f"__esmDefine({json.dumps(mid)}, function () {{\n{_esm_to_function(src, file, ids)}\n}});"
        return mid

    machine = add_cjs(machine_dir / "machine.cjs")
    effects = add_cjs(machine_dir / "effects.cjs") if (machine_dir / "effects.cjs").exists() else None
    host = add_esm(kernel_src / "machine-host.mjs")
    sha = ids.get(str((kernel_src / "sha256.mjs").resolve()))
    contract = json.loads((machine_dir / "contract.json").read_text(encoding="utf-8"))
    manifest_file = machine_dir / "effects.manifest.json"
    manifest = json.loads(manifest_file.read_text(encoding="utf-8")) if manifest_file.exists() else None
    return "\n".join([_PRELUDE, *code.values(), _GLUE % {
        "host": json.dumps(host), "machine": json.dumps(machine), "effects": json.dumps(effects),
        "contract": json.dumps(contract), "manifest": json.dumps(manifest),
        "sha": json.dumps(sha), "host_hash": "true" if host_hash and sha else "false",
    }])


_PRELUDE = r"""
'use strict';
// The clock is WORKFLOW time, as in the TS workflow isolate: Date.now() and
// new Date() read the `now` of the call (the host's own step input), so a
// machine that reads the clock steps the same in both hosts, on every replay
// (P9 review QJ2). Randomness and timers have no deterministic equivalent
// here: using them marks the call, and the call POISONS, even when the machine
// (or sam-pattern) swallows the throw, so it is never a silent 'unhandled'.
var __now = 0, __forbidden = null;
(function () {
  const D = Date;
  function WorkflowDate(...a) {
    if (!new.target) return new D(__now).toString();
    return a.length === 0 ? new D(__now) : new D(...a);
  }
  WorkflowDate.prototype = D.prototype; WorkflowDate.UTC = D.UTC; WorkflowDate.parse = D.parse;
  WorkflowDate.now = () => __now;
  globalThis.Date = WorkflowDate;
  const refuse = (what) => () => { if (__forbidden === null) __forbidden = what; throw new Error(what); };
  Math.random = refuse('a machine has no randomness');
  globalThis.setTimeout = globalThis.setInterval = refuse('a machine has no timers');
  const log = [];
  const keep = (...a) => { if (log.length < 50) log.push(a.map(String).join(' ')); };
  globalThis.console = { log: keep, warn: keep, error: keep, info: keep, debug: keep };
  globalThis.__consoleLog = log;
})();
const __defs = {}, __cache = {};
function __cjs(id, mapping, fn) { __defs[id] = { kind: 'cjs', mapping, fn }; }
function __esmDefine(id, fn) { __defs[id] = { kind: 'esm', fn }; }
function __load(id) {
  if (id in __cache) return __cache[id];
  const d = __defs[id];
  if (!d) throw new Error('no module ' + id);
  if (d.kind === 'esm') { __cache[id] = d.fn(); return __cache[id]; }
  const module = { exports: {} };
  __cache[id] = module.exports;
  const require = (spec) => {
    if (!(spec in d.mapping)) throw new Error("require('" + spec + "') is not in the bundle");
    return __load(d.mapping[spec]);
  };
  d.fn.call(module.exports, module, module.exports, require);
  __cache[id] = module.exports;
  return module.exports;
}
function __esm(id) { return __load(id); }
"""

_GLUE = r"""
const __hashes = [];
if (%(host_hash)s) {
  // The kernel host's own code runs unchanged; only its hash primitive defers to the host.
  const real = __esm(%(sha)s);
  __cache[%(sha)s] = Object.assign({}, real, {
    sha256hex: (s) => {
      if (typeof s !== 'string') return real.sha256hex(s);
      __hashes.push(s);
      return ('#' + (__hashes.length - 1) + '#').padEnd(64, '#');
    },
  });
}
const __host = __esm(%(host)s).createHost({
  module: __load(%(machine)s),
  contract: %(contract)s,
  mapper: %(effects)s === null ? null : __load(%(effects)s).effects,
  manifest: %(manifest)s,
});
globalThis.__polyflow = function (text) {
  const r = JSON.parse(text);
  __hashes.length = 0;
  __now = typeof r.now === 'number' ? r.now : 0;
  __forbidden = null;
  let out;
  try {
    switch (r.op) {
      case 'init': out = __host.init(); break;
      case 'step': out = __host.step(r.state, r.action, 'data' in r ? r.data : undefined, { runKey: r.runKey, seq: r.seq, now: r.now }); break;
      case 'dryRun': out = __host.dryRun(r.state, r.action, 'data' in r ? r.data : undefined); break;
      case 'checkSnapshot': out = __host.checkSnapshot(r.snap); break;
      case 'completionAction': out = __host.completionAction(r.kind, r.outcome, { result: r.result, message: r.message }); break;
      case 'isTerminal': out = __host.isTerminal(r.state); break;
      case 'describe': out = { keys: __host.keys, actions: __host.actions }; break;
      default: return JSON.stringify({ __error: 'unknown op ' + r.op });
    }
  } catch (err) {
    return JSON.stringify({ __error: String(err && err.message || err) });
  }
  if (__forbidden !== null && (r.op === 'step' || r.op === 'dryRun')) {
    out = r.op === 'step' ? { poisoned: __forbidden } : { stepKind: 'poisoned', reason: __forbidden };
  }
  return JSON.stringify({ value: out === undefined ? null : out, hashes: __hashes });
};
"""


# ---- the host -------------------------------------------------------------------

_PLACEHOLDER = re.compile(r"#(\d+)#*")
_LONE = re.compile("[\ud800-\udfff]")


def _js_sha256(text: str) -> str:
    """The kernel's sha256hex: UTF-8, with a lone surrogate as U+FFFD (what its utf8() does)."""
    return hashlib.sha256(_LONE.sub("�", text).encode("utf-8")).hexdigest()


def _fill_intent_ids(value, hashes: list) -> None:
    for e in (value.get("effects") or []) if isinstance(value, dict) else []:
        m = _PLACEHOLDER.fullmatch(str(e.get("intentId", "")))
        if m:
            e["intentId"] = _js_sha256(hashes[int(m.group(1))])[:32]


def _default_engine() -> str:
    try:
        import wasmtime  # noqa: F401
    except ImportError:
        return "native"
    return "wasm" if VENDORED_WASM.exists() else "native"


class QuickJSMachineHost:
    """The kernel's createHost, in QuickJS. Every call rehydrates from the state
    it is given, so a step sees no residue of another run or another step.

    ``engine="wasm"`` (the default when ``wasmtime`` is installed): QuickJS-NG
    as WebAssembly under wasmtime, budgeted in FUEL (instructions). ``engine="native"``:
    the ``quickjs`` binding, budgeted in CPU seconds."""

    def __init__(self, machine_dir: str | Path | None = None, *, source: str | None = None,
                 engine: str | None = None, fuel: int = DEFAULT_FUEL,
                 time_limit_s: float = DEFAULT_TIME_LIMIT_S, memory_limit: int = DEFAULT_MEMORY_LIMIT,
                 kernel_src: str | Path = KERNEL_SRC, wasm_path: str | Path = VENDORED_WASM, host_hash: bool = True):
        if source is None:
            if machine_dir is None:
                raise ValueError("give a machine directory or a bundle source")
            source = bundle(machine_dir, kernel_src=kernel_src, host_hash=host_hash)
        self.source = source
        self.digest = "sha256:" + hashlib.sha256(source.encode("utf-8")).hexdigest()
        self.engine = engine or _default_engine()
        if self.engine not in ("wasm", "native"):
            raise ValueError(f"engine '{self.engine}' (wasm | native)")
        self.fuel, self.time_limit_s, self.memory_limit, self._wasm_path = fuel, time_limit_s, memory_limit, wasm_path
        self._js = None
        # One engine, many workflow threads: the Python worker runs workflow
        # activations on a thread pool, and neither QuickJS nor a wasmtime Store
        # may be entered by two threads at once.
        self._lock = threading.RLock()
        self._boot()
        d = self._call({"op": "describe"})
        self.keys, self.actions = d["keys"], d["actions"]

    def _boot(self):
        if self.engine == "wasm":
            js = WasmQuickJS(fuel=self.fuel, memory_limit=self.memory_limit, stack_bytes=MAX_STACK_BYTES, wasm_path=self._wasm_path)
        else:
            js = NativeQuickJS(time_limit_s=self.time_limit_s, memory_limit=self.memory_limit, stack_bytes=MAX_STACK_BYTES,
                               load_time_limit_s=LOAD_TIME_LIMIT_S)
        try:
            js.load(self.source)
        except (EngineError, EngineBudget) as err:
            raise MachineLoadError(f"the machine does not load: {err}") from None
        self._js = js

    @property
    def budget(self) -> str:
        return f"{self.fuel} fuel" if self.engine == "wasm" else f"{self.time_limit_s}s CPU"

    def _call(self, request: dict):
        with self._lock:
            return self._call_locked(request)

    def _call_locked(self, request: dict):
        try:
            text = self._js.call("__polyflow", json.dumps(request))  # ASCII: a lone surrogate travels as \u escape
        except EngineBudget as err:
            # Out of fuel / CPU, out of memory, or a stack overflow: the engine is not trusted again.
            self._boot()
            raise MachineBudgetExceeded(f"machine step exceeded its budget ({self.budget}, {self.memory_limit} bytes): {err}") from None
        out = json.loads(text)
        if "__error" in out:
            raise MachineLoadError(out["__error"])
        value = out["value"]
        # QuickJS lets code catch an out-of-memory, and the kernel host turns the
        # throw into { poisoned }. Whether a poison was really a resource failure
        # is decided by an ENGINE signal (the wasm heap grew past half its cap
        # during this call), never by the poison's text: a machine error that
        # says "interrupted" is a machine defect, quarantined as in TS (QJ3).
        if isinstance(value, dict) and "poisoned" in value and self._js.memory_exhausted():
            self._boot()
            raise MachineBudgetExceeded(f"machine step exhausted its memory ({self.memory_limit} bytes): {value['poisoned']}")
        if out.get("hashes"):
            _fill_intent_ids(value, out["hashes"])
        return value

    # The kernel host's surface, one to one.

    def init(self, *, now: int = 0) -> dict:
        return self._call({"op": "init", "now": now})

    def step(self, state: dict | None, action: str, data: Any = ..., *, run_key: str = "", seq: int = 0, now: int = 0) -> dict:
        req = {"op": "step", "state": state, "action": action, "runKey": run_key, "seq": seq, "now": now}
        if data is not ...:
            req["data"] = data
        return self._call(req)

    def dry_run(self, state: dict | None, action: str, data: Any = ..., *, now: int = 0) -> dict:
        req = {"op": "dryRun", "state": state, "action": action, "now": now}
        if data is not ...:
            req["data"] = data
        return self._call(req)

    def check_snapshot(self, snap, *, now: int = 0) -> str | None:
        return self._call({"op": "checkSnapshot", "snap": snap, "now": now})

    def completion_action(self, kind: str, outcome: str, *, result: Any = None, message: str | None = None) -> dict | None:
        req = {"op": "completionAction", "kind": kind, "outcome": outcome}
        if result is not None:
            req["result"] = result
        if message is not None:
            req["message"] = message
        return self._call(req)

    def is_terminal(self, state: dict) -> bool:
        return self._call({"op": "isTerminal", "state": state})

    def eval_untrusted(self, code: str) -> str:
        """For sandbox tests only: evaluate code in the machine's engine, under its budget.
        Returns String(result) (or 'threw: <error>'), after running pending jobs."""
        try:
            with self._lock:
                return self._js.eval(code)
        except EngineBudget as err:
            self._boot()
            raise MachineBudgetExceeded(str(err)) from None


# ---- a registry the workflow sandbox can reach ----------------------------------
#
# Workflow modules are re-imported inside the Temporal sandbox; this module is a
# passthrough (PolyflowPlugin marks the package so), so a host built once at
# worker start-up, from files, is reached from workflow code by name, and the
# workflow itself reads no file.

_MACHINES: dict[str, QuickJSMachineHost] = {}


def register_machine(name: str, host: QuickJSMachineHost) -> QuickJSMachineHost:
    _MACHINES[name] = host
    return host


def machine(name: str) -> QuickJSMachineHost:
    try:
        return _MACHINES[name]
    except KeyError:
        raise LookupError(f"no machine '{name}' is registered on this worker") from None
