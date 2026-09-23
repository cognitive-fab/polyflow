"""Two QuickJS engines behind one interface, for the G2 machine host.

``WasmQuickJS`` (preferred): QuickJS-NG compiled to WebAssembly (the
``quickjs-wasi`` build, vendored with its licence under ``vendor/quickjs-wasi``,
see PROVENANCE there), run under wasmtime. The guest gets NO real host
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

import functools
from pathlib import Path

VENDORED_WASM = Path(__file__).resolve().parent / "vendor" / "quickjs-wasi" / "quickjs.wasm"


class EngineBudget(Exception):
    pass


class EngineError(Exception):
    pass


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

@functools.lru_cache(maxsize=4)
def _compiled(path: str):
    import wasmtime
    cfg = wasmtime.Config()
    cfg.consume_fuel = True
    engine = wasmtime.Engine(cfg)
    return engine, wasmtime.Module.from_file(engine, path)


class WasmQuickJS:
    kind = "wasm"

    ERRNO_BADF = 8
    ERRNO_NOSYS = 52

    def __init__(self, *, fuel: int, memory_limit: int, stack_bytes: int, load_fuel: int = 2_000_000_000,
                 wasm_path: str | Path = VENDORED_WASM):
        import wasmtime
        self._w = wasmtime
        self._fuel, self._load_fuel = fuel, load_fuel
        self._memory_limit = memory_limit
        self._heap_before = self._heap_after = 0
        engine, module = _compiled(str(wasm_path))
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
