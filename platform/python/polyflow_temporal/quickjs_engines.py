"""Two QuickJS engines behind one interface, for the G2 machine host.

``WasmQuickJS`` (preferred): QuickJS-NG compiled to WebAssembly (the
``quickjs-wasi`` build; its licence and provenance live under
``vendor/quickjs-wasi``), run under wasmtime. The .wasm itself is not shipped:
it is fetched from the npm registry on first use (or ahead of time with
``python -m polyflow_temporal.quickjs_engines fetch``) and pinned by sha256,
see :func:`resolve_quickjs_wasm`. The guest gets NO real host
imports: every WASI and ``env`` function it declares is a stub defined here
(no clock: time is 0; no entropy: random bytes are 0; no files, no sockets; no
module loader; no host functions). Its budget is wasmtime FUEL, so a runaway
step is stopped after a deterministic number of instructions, and a memory
cap on the store bounds its linear memory.

``NativeQuickJS``: the ``quickjs`` PyPI binding (QuickJS in-process, native).
No host bindings either, but the boundary is QuickJS's own C code, and its
budget is CPU time (``clock()``), so exhaustion is not deterministic.

Both expose: ``load(source)``, ``call(name, text) -> text``, ``eval(code) -> str``,
and raise :class:`EngineBudget` when a budget is exhausted (after which the
engine must be rebuilt: neither is trusted again).
"""

from __future__ import annotations

import hashlib
import io
import os
import sys
import tarfile
import tempfile
import threading
from pathlib import Path

# Where a dev tree may still hold the wasm (git-ignored). Kept as the default
# ``wasm_path`` sentinel: passing it means "resolve the pinned build".
VENDORED_WASM = Path(__file__).resolve().parent / "vendor" / "quickjs-wasi" / "quickjs.wasm"

# The pinned build (see vendor/quickjs-wasi/PROVENANCE.txt).
QUICKJS_WASI_VERSION = "3.6.2"
QUICKJS_WASI_TARBALL_URL = f"https://registry.npmjs.org/quickjs-wasi/-/quickjs-wasi-{QUICKJS_WASI_VERSION}.tgz"
QUICKJS_WASI_TARBALL_SHA256 = "f1f4349f19a2d849e33ea0ae9bec2e7062b8839f4eceb17c9051ddbaa2720982"
QUICKJS_WASM_SHA256 = "d4c9375f2b1ca4dc95f72c8aa2982a7a9951ac8011490d79c6582df732b4bbd9"
_TARBALL_MEMBER = "package/quickjs.wasm"
_MAX_DOWNLOAD = 64 * 1024 * 1024

ENV_WASM_PATH = "POLYFLOW_QUICKJS_WASM"
ENV_NO_FETCH = "POLYFLOW_QUICKJS_NO_FETCH"
FETCH_COMMAND = "python -m polyflow_temporal.quickjs_engines fetch"


class EngineBudget(Exception):
    pass


class EngineError(Exception):
    pass


class QuickJSWasmUnavailable(EngineError):
    """The pinned QuickJS wasm is not on disk and may not (or could not) be fetched."""


class QuickJSWasmMismatch(EngineError):
    """A QuickJS wasm (or its tarball) does not hash to the pinned sha256: refused."""


# ---- the pinned wasm: resolve, verify, fetch --------------------------------------

def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def cache_dir() -> Path:
    """The user cache directory for the fetched wasm (no platformdirs):
    ``%LOCALAPPDATA%/polyflow`` on Windows, else ``$XDG_CACHE_HOME/polyflow``
    or ``~/.cache/polyflow``."""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    else:
        base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "polyflow"


def cached_wasm_path(root: str | Path | None = None) -> Path:
    return Path(root if root is not None else cache_dir()) / f"quickjs-wasi-{QUICKJS_WASI_VERSION}" / "quickjs.wasm"


def read_verified_wasm(path: str | Path) -> bytes:
    """The bytes of ``path``, only if they hash to the pinned sha256. The caller
    uses these bytes (not the file again), so what is checked is what is run."""
    p = Path(path)
    try:
        data = p.read_bytes()
    except FileNotFoundError:
        raise QuickJSWasmUnavailable(f"no QuickJS wasm at {p}") from None
    digest = _sha256(data)
    if digest != QUICKJS_WASM_SHA256:
        raise QuickJSWasmMismatch(
            f"refusing {p}: sha256 {digest} is not the pinned quickjs-wasi@{QUICKJS_WASI_VERSION} "
            f"build ({QUICKJS_WASM_SHA256}). Delete it and run `{FETCH_COMMAND}`.")
    return data


def _candidates() -> list[tuple[str, Path]]:
    out = []
    env = os.environ.get(ENV_WASM_PATH)
    if env:
        out.append((ENV_WASM_PATH, Path(env)))
    out.append(("cache", cached_wasm_path()))
    out.append(("vendor", VENDORED_WASM))
    return out


def resolve_quickjs_wasm(*, fetch: bool | None = None) -> Path:
    """The path of a verified copy of the pinned wasm, from (1) ``$POLYFLOW_QUICKJS_WASM``,
    (2) the user cache, (3) the dev-tree vendor path. If none exists, fetch it into the
    cache, unless ``fetch`` is False or ``$POLYFLOW_QUICKJS_NO_FETCH=1``. An explicit
    ``$POLYFLOW_QUICKJS_WASM`` must exist; any file found that does not hash to the pin
    is refused (never skipped over)."""
    for source, path in _candidates():
        if source == ENV_WASM_PATH and not path.is_file():
            raise QuickJSWasmUnavailable(f"${ENV_WASM_PATH} names {path}, which does not exist")
        if path.is_file():
            read_verified_wasm(path)
            return path
    if fetch is None:
        fetch = os.environ.get(ENV_NO_FETCH, "").strip().lower() not in ("1", "true", "yes", "on")
    if not fetch:
        raise QuickJSWasmUnavailable(
            f"the QuickJS wasm (quickjs-wasi@{QUICKJS_WASI_VERSION}) is not installed and network fetch "
            f"is disabled (${ENV_NO_FETCH}=1). Pre-populate the cache with `{FETCH_COMMAND}` "
            f"(it writes {cached_wasm_path()}), or point ${ENV_WASM_PATH} at a copy.")
    return fetch_quickjs_wasm()


def _download(url: str) -> bytes:
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "polyflow-temporal"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (fixed https URL)
        data = resp.read(_MAX_DOWNLOAD + 1)
    if len(data) > _MAX_DOWNLOAD:
        raise QuickJSWasmUnavailable(f"{url} is larger than {_MAX_DOWNLOAD} bytes")
    return data


_fetch_lock = threading.Lock()


def fetch_quickjs_wasm(*, root: str | Path | None = None, force: bool = False) -> Path:
    """Download the pinned quickjs-wasi tarball, check its sha256, take
    ``package/quickjs.wasm`` out of it (in memory, nothing else is extracted), check
    that sha256 too, and write it atomically into the cache. Returns the path."""
    dest = cached_wasm_path(root)
    with _fetch_lock:
        if dest.is_file() and not force:
            read_verified_wasm(dest)
            return dest
        try:
            tgz = _download(QUICKJS_WASI_TARBALL_URL)
        except OSError as err:
            raise QuickJSWasmUnavailable(
                f"could not download {QUICKJS_WASI_TARBALL_URL}: {err}. Set ${ENV_WASM_PATH} to a "
                f"verified copy, or run `{FETCH_COMMAND}` where the registry is reachable.") from None
        digest = _sha256(tgz)
        if digest != QUICKJS_WASI_TARBALL_SHA256:
            raise QuickJSWasmMismatch(
                f"refusing {QUICKJS_WASI_TARBALL_URL}: sha256 {digest}, pinned {QUICKJS_WASI_TARBALL_SHA256}")
        try:
            with tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz") as tar:
                member = tar.getmember(_TARBALL_MEMBER)
                f = tar.extractfile(member) if member.isfile() else None
                if f is None:
                    raise KeyError(_TARBALL_MEMBER)
                wasm = f.read()
        except (KeyError, tarfile.TarError) as err:
            raise QuickJSWasmMismatch(f"the pinned tarball has no usable {_TARBALL_MEMBER}: {err}") from None
        digest = _sha256(wasm)
        if digest != QUICKJS_WASM_SHA256:
            raise QuickJSWasmMismatch(f"refusing {_TARBALL_MEMBER}: sha256 {digest}, pinned {QUICKJS_WASM_SHA256}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".quickjs-", suffix=".tmp", dir=dest.parent)
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(wasm)
                out.flush()
                os.fsync(out.fileno())
            os.replace(tmp, dest)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        return dest


def _main(argv: list[str]) -> int:
    usage = f"usage: {FETCH_COMMAND} [--force] | python -m polyflow_temporal.quickjs_engines path"
    if not argv or argv[0] in ("-h", "--help"):
        print(usage)
        return 0 if argv else 2
    cmd, rest = argv[0], argv[1:]
    try:
        if cmd == "fetch" and set(rest) <= {"--force"}:
            # The explicit, operator-run fetch: $POLYFLOW_QUICKJS_NO_FETCH does not apply.
            print(fetch_quickjs_wasm(force="--force" in rest))
            return 0
        if cmd == "path" and not rest:
            print(resolve_quickjs_wasm(fetch=False))
            return 0
    except EngineError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    print(usage, file=sys.stderr)
    return 2


# ---- native -------------------------------------------------------------------------

class NativeQuickJS:
    kind = "native"

    def __init__(self, *, time_limit_s: float, memory_limit: int, stack_bytes: int, load_time_limit_s: float = 5.0):
        import quickjs
        self._qjs = quickjs
        self._ctx = quickjs.Context()
        self._ctx.set_memory_limit(memory_limit)
        self._ctx.set_max_stack_size(stack_bytes)
        self._time_limit_s = time_limit_s
        self._load_time_limit_s = load_time_limit_s
        self._fns: dict = {}

    def load(self, source: str) -> None:
        self._ctx.set_time_limit(self._load_time_limit_s)
        try:
            self._ctx.eval(source)
        except self._qjs.JSException as err:
            raise EngineError(str(err)) from None
        finally:
            self._ctx.set_time_limit(self._time_limit_s)

    def call(self, name: str, text: str) -> str:
        fn = self._fns.get(name) or self._fns.setdefault(name, self._ctx.get(name))
        try:
            return fn(text)
        except self._qjs.JSException as err:
            raise EngineBudget(str(err).splitlines()[0] if str(err) else "out of memory") from None

    def memory_exhausted(self) -> bool:
        """The native binding exposes no allocation high-water mark: a caught
        out-of-memory is a (deterministic, limit-bound) poison here. The wasm
        engine is the one that tells them apart."""
        return False

    def eval(self, code: str) -> str:
        # Tests only: evaluates code INSIDE the sandboxed JS engine (JS eval, not Python's).
        try:
            v = self._ctx.eval(f"String((() => {{ try {{ return eval({_js_string(code)}); }} catch (e) {{ return 'threw: ' + e; }} }})())")
        except self._qjs.JSException as err:
            raise EngineBudget(str(err).splitlines()[0] if str(err) else "out of memory") from None
        while self._ctx.execute_pending_job():
            pass
        return v


def _js_string(s: str) -> str:
    import json
    return json.dumps(s)


# ---- wasm ---------------------------------------------------------------------------

_compiled_cache: dict = {}
_compiled_lock = threading.Lock()


def _compiled(wasm: bytes):
    """Compile verified bytes (not a path: the file is not re-read after its hash
    was checked). Cached by content hash."""
    import wasmtime
    key = _sha256(wasm)
    with _compiled_lock:
        hit = _compiled_cache.get(key)
        if hit is None:
            cfg = wasmtime.Config()
            cfg.consume_fuel = True
            engine = wasmtime.Engine(cfg)
            hit = _compiled_cache[key] = (engine, wasmtime.Module(engine, wasm))
        return hit


def _load_wasm(wasm_path: str | Path | None) -> bytes:
    """``None`` or the ``VENDORED_WASM`` sentinel: resolve (and fetch if allowed).
    Any other path: that file. Either way the bytes are verified on every load."""
    if wasm_path is None or Path(wasm_path) == VENDORED_WASM:
        wasm_path = resolve_quickjs_wasm()
    return read_verified_wasm(wasm_path)


class WasmQuickJS:
    kind = "wasm"

    ERRNO_BADF = 8
    ERRNO_NOSYS = 52

    def __init__(self, *, fuel: int, memory_limit: int, stack_bytes: int, load_fuel: int = 2_000_000_000,
                 wasm_path: str | Path | None = VENDORED_WASM):
        import wasmtime
        self._w = wasmtime
        self._fuel, self._load_fuel = fuel, load_fuel
        self._memory_limit = memory_limit
        self._heap_before = self._heap_after = 0
        engine, module = _compiled(_load_wasm(wasm_path))
        store = wasmtime.Store(engine)
        # Linear memory is capped by the store, whatever the guest asks for.
        store.set_limits(memory_size=memory_limit + 16 * 1024 * 1024)
        store.set_fuel(load_fuel)
        linker = wasmtime.Linker(engine)
        i32, i64 = wasmtime.ValType.i32(), wasmtime.ValType.i64()
        F = wasmtime.FuncType

        def mem(caller):
            return caller["memory"]

        def clock_time_get(caller, _clock, _precision, out_ptr):
            mem(caller).write(caller, bytes(8), out_ptr)  # no clock: time is 0
            return 0

        def random_get(caller, ptr, n):
            mem(caller).write(caller, bytes(n), ptr)      # no entropy: zeros
            return 0

        def fd_write(caller, fd, iovs, n_iovs, nwritten_ptr):
            m = mem(caller)
            total = 0
            for i in range(n_iovs):
                raw = m.read(caller, iovs + 8 * i, iovs + 8 * i + 8)
                total += int.from_bytes(raw[4:8], "little")
            m.write(caller, total.to_bytes(4, "little"), nwritten_ptr)  # swallowed, never reaches a host fd
            return 0

        stubs = {
            ("wasi_snapshot_preview1", "clock_time_get"): (F([i32, i64, i32], [i32]), clock_time_get, True),
            ("wasi_snapshot_preview1", "random_get"): (F([i32, i32], [i32]), random_get, True),
            ("wasi_snapshot_preview1", "fd_write"): (F([i32, i32, i32, i32], [i32]), fd_write, True),
            ("wasi_snapshot_preview1", "fd_close"): (F([i32], [i32]), lambda _fd: self.ERRNO_NOSYS, False),
            ("wasi_snapshot_preview1", "fd_fdstat_get"): (F([i32, i32], [i32]), lambda _fd, _p: self.ERRNO_BADF, False),
            ("wasi_snapshot_preview1", "fd_seek"): (F([i32, i64, i32, i32], [i32]), lambda *_: self.ERRNO_NOSYS, False),
            ("env", "host_get_timezone_offset"): (F([i32, i32], [i32]), lambda *_: 0, False),
            ("env", "host_interrupt"): (F([], [i32]), lambda: 0, False),
            ("env", "host_promise_rejection"): (F([i32, i32, i32], []), lambda *_: None, False),
            ("env", "host_module_normalize"): (F([i32, i32], [i32]), lambda *_: 0, False),  # no module loader
            ("env", "host_module_load"): (F([i32, i32], [i32]), lambda *_: 0, False),
            ("env", "host_call"): (F([i32, i32, i32, i32, i32], [i32]), lambda *_: 0, False),  # no host functions
        }
        declared = {(imp.module, imp.name) for imp in module.imports}
        if declared - set(stubs):
            raise EngineError(f"the wasm build imports more than this host provides: {sorted(declared - set(stubs))}")
        for (mod, name), (ty, fn, caller) in stubs.items():
            if (mod, name) in declared:
                linker.define_func(mod, name, ty, fn, access_caller=caller)
        inst = linker.instantiate(store, module)
        ex = inst.exports(store)
        self._store, self._x, self._mem = store, ex, ex["memory"]
        try:
            ex["_initialize"](store)
            if ex["qjs_init"](store) != 0:
                raise EngineError("QuickJS did not initialise")
        except wasmtime.Trap as err:
            raise EngineError(f"QuickJS did not initialise: {err}") from None
        ex["qjs_set_memory_limit"](store, memory_limit)
        ex["qjs_set_max_stack_size"](store, stack_bytes)
        self._fns: dict = {}
        self._f = {n: ex[n] for n in ("qjs_new_string", "qjs_call", "qjs_free_value", "qjs_is_exception", "qjs_get_string_len", "qjs_free_cstring")}
        self._slots = ex["wasm_malloc"](store, 16)  # argv[0] at +0, an out-length at +4
        self._scratch_ptr, self._scratch_size = 0, 0
        self._global = ex["qjs_get_global"](store)
        self._undefined = ex["qjs_get_undefined"](store)

    # -- memory helpers
    def _put(self, data: bytes) -> int:
        ptr = self._x["wasm_malloc"](self._store, len(data) + 1)
        if not ptr:
            raise EngineBudget("out of memory")
        self._mem.write(self._store, data + b"\0", ptr)
        return ptr

    def _free(self, ptr: int) -> None:
        self._x["wasm_free"](self._store, ptr)

    def _string_of(self, value_ptr: int) -> str:
        len_ptr = self._x["wasm_malloc"](self._store, 4)
        try:
            c = self._x["qjs_get_string_len"](self._store, value_ptr, len_ptr)
            n = int.from_bytes(self._mem.read(self._store, len_ptr, len_ptr + 4), "little")
            try:
                return bytes(self._mem.read(self._store, c, c + n)).decode("utf-8", "surrogatepass")
            finally:
                self._x["qjs_free_cstring"](self._store, c)
        finally:
            self._free(len_ptr)

    def _exception_text(self) -> str:
        exc = self._x["qjs_get_exception"](self._store)
        try:
            return self._string_of(exc)
        finally:
            self._x["qjs_free_value"](self._store, exc)

    def _heap(self) -> int:
        return self._mem.data_len(self._store)

    def memory_exhausted(self) -> bool:
        """Did the last call push the guest heap past half its cap? Wasm linear
        memory never shrinks, so its size is a high-water mark the guest cannot
        forge without actually allocating: an engine signal, not a message."""
        return self._heap_after > self._heap_before and self._heap_after >= self._memory_limit // 2

    def _guard(self, fuel: int, fn):
        self._store.set_fuel(fuel)
        self._heap_before = self._heap()
        try:
            return fn()
        except self._w.Trap as err:
            code = getattr(err, "trap_code", None)
            why = str(err).strip().splitlines()[-1].strip() if str(err).strip() else "trap"
            raise EngineBudget(f"stopped by the wasm sandbox ({code.name if code is not None else 'trap'}: {why})") from None
        except self._w.WasmtimeError as err:
            raise EngineBudget(f"stopped by the wasm sandbox: {str(err).strip().splitlines()[-1]}") from None
        finally:
            self._heap_after = self._heap()

    def load(self, source: str) -> None:
        def go():
            code = self._put(source.encode("utf-8", "surrogatepass"))
            name = self._put(b"<machine>")
            try:
                r = self._x["qjs_eval"](self._store, code, len(source.encode("utf-8", "surrogatepass")), name, 0)
            finally:
                self._free(code)
                self._free(name)
            try:
                if self._x["qjs_is_exception"](self._store, r):
                    raise EngineError(self._exception_text())
            finally:
                self._x["qjs_free_value"](self._store, r)
        self._guard(self._load_fuel, go)

    def _scratch(self, n: int) -> int:
        """A persistent guest buffer for call arguments: each wasm call from Python
        costs ~20us, so a step makes as few as it can (no malloc/free per call)."""
        if n + 1 > self._scratch_size:
            if self._scratch_ptr:
                self._free(self._scratch_ptr)
            size = max(4096, 1 << (n + 1).bit_length())
            self._scratch_ptr = self._x["wasm_malloc"](self._store, size)
            if not self._scratch_ptr:
                raise EngineBudget("out of memory")
            self._scratch_size = size
        return self._scratch_ptr

    def call(self, name: str, text: str) -> str:
        f = self._f

        def go():
            fn = self._fns.get(name)
            if fn is None:
                key = self._put(name.encode())
                try:
                    fn = self._fns[name] = self._x["qjs_get_prop_string"](self._store, self._global, key)
                finally:
                    self._free(key)
            data = text.encode("utf-8", "surrogatepass")
            buf = self._scratch(len(data))
            self._mem.write(self._store, data, buf)
            arg = f["qjs_new_string"](self._store, buf, len(data))
            self._mem.write(self._store, arg.to_bytes(4, "little"), self._slots)
            try:
                r = f["qjs_call"](self._store, fn, self._undefined, 1, self._slots)
            finally:
                f["qjs_free_value"](self._store, arg)
            try:
                if f["qjs_is_exception"](self._store, r):
                    raise EngineBudget(self._exception_text())
                c = f["qjs_get_string_len"](self._store, r, self._slots + 4)
                n = int.from_bytes(self._mem.read(self._store, self._slots + 4, self._slots + 8), "little")
                try:
                    return bytes(self._mem.read(self._store, c, c + n)).decode("utf-8", "surrogatepass")
                finally:
                    f["qjs_free_cstring"](self._store, c)
            finally:
                f["qjs_free_value"](self._store, r)
        return self._guard(self._fuel, go)

    def eval(self, code: str) -> str:
        # Tests only: evaluates code INSIDE the wasm guest (JS eval, not Python's).
        wrapped = f"String((() => {{ try {{ return eval({_js_string(code)}); }} catch (e) {{ return 'threw: ' + e; }} }})())"

        def go():
            data = wrapped.encode("utf-8", "surrogatepass")
            cptr, nptr = self._put(data), self._put(b"<eval>")
            try:
                r = self._x["qjs_eval"](self._store, cptr, len(data), nptr, 0)
            finally:
                self._free(cptr)
                self._free(nptr)
            try:
                if self._x["qjs_is_exception"](self._store, r):
                    return "threw: " + self._exception_text()
                out = self._string_of(r)
            finally:
                self._x["qjs_free_value"](self._store, r)
            while self._x["qjs_execute_pending_job"](self._store) > 0:
                pass
            return out
        return self._guard(self._fuel, go)

    def fuel_used(self) -> int:
        return self._fuel - self._store.get_fuel()


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
