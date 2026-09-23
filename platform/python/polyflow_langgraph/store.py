"""The per-thread governance record: the authority for a thread's chain and guard.

A LangGraph thread's chain head, guard state, decided turns and effect outcomes
live HERE, keyed by (ns, thread), never in the agent's message list (P10
review LG2-LG6): a message list is unauthenticated, is rewritten by trimming,
``update_state`` and time travel, and is not the thread (subagents each have
one). Every decision is a read-modify-write of this record inside
``transaction``, which serialises every worker on the thread, in this process
and across processes over the same directory (LG5, LG7).

Tool results are NOT in the record. They are blobs beside it (``put_blob`` /
``get_blob``), one per effect, so a transaction's cost does not grow with the
output a thread retains for replays.

Two stores, placed with the sink by default so the record is as durable as the
ledger it continues:

- ``MemoryThreadStore``: in process (tests, a ``MemorySink``);
- ``FileThreadStore(root)``: ``<root>/<ns>/<thread>/thread.state.json`` beside the
  ``FileSink``'s run files, written atomically under an OS file lock, with
  ``<root>/<ns>/<thread>/results/<effect>.json`` for retained results.
"""

from __future__ import annotations

import contextlib
import json
import os
import threading
import time
import zlib
from pathlib import Path

from polyflow_temporal.sinks import FileSink, MemorySink, safe_component

STRIPES = 64


def _stripe(key) -> int:
    return zlib.crc32(repr(key).encode("utf-8")) % STRIPES


# Striped, so the lock table never grows with the number of threads seen (review 8).
_PROCESS_LOCKS = [threading.Lock() for _ in range(STRIPES)]


def dumps(value) -> str:
    """JSON that never fails after a side effect: anything JSON cannot carry is
    written as its ``str`` (review 5)."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


class _Txn:
    def __init__(self, record):
        self.record = record
        self.committed = None

    def commit(self, record: dict):
        self.committed = json.loads(dumps(record))  # JSON-shaped, and detached from the caller


class MemoryThreadStore:
    def __init__(self):
        self._records: dict = {}
        self._blobs: dict = {}
        self._locks = [threading.Lock() for _ in range(STRIPES)]

    @contextlib.contextmanager
    def transaction(self, ns: str, thread: str):
        key = (ns, thread)
        with self._locks[_stripe(key)]:
            rec = self._records.get(key)
            txn = _Txn(json.loads(dumps(rec)) if rec is not None else None)
            yield txn
            if txn.committed is not None:
                self._records[key] = txn.committed

    def peek(self, ns: str, thread: str):
        rec = self._records.get((ns, thread))
        return json.loads(dumps(rec)) if rec is not None else None

    def put_blob(self, ns: str, thread: str, name: str, value) -> None:
        self._blobs[(ns, thread, name)] = json.loads(dumps(value))

    def get_blob(self, ns: str, thread: str, name: str):
        v = self._blobs.get((ns, thread, name))
        return json.loads(dumps(v)) if v is not None else None

    def delete_blob(self, ns: str, thread: str, name: str) -> None:
        self._blobs.pop((ns, thread, name), None)


@contextlib.contextmanager
def _file_lock(path: Path, timeout: float = 60.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
    locked = False
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(fd, 0, 0)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"could not lock {path} within {timeout}s") from None
                time.sleep(0.002)
        yield
    finally:
        if locked:
            try:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(fd, 0, 0)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
        os.close(fd)


def _write_atomically(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


class FileThreadStore:
    """One JSON record per thread, beside the FileSink's run files. Several
    processes may share the directory: every transaction holds an OS lock."""

    def __init__(self, root: str | os.PathLike):
        self.root = Path(root)

    def _dir(self, ns: str, thread: str) -> Path:
        root = self.root.resolve()
        d = root / safe_component(ns) / safe_component(thread)
        if root not in d.resolve().parents:
            raise ValueError(f"thread record for {thread!r} resolves outside the store root: refused")
        return d

    def _blob(self, ns: str, thread: str, name: str) -> Path:
        d = self._dir(ns, thread)
        p = d / "results" / f"{safe_component(name)}.json"
        if d not in p.resolve().parents:
            raise ValueError("blob name resolves outside the thread's directory: refused")
        return p

    @contextlib.contextmanager
    def transaction(self, ns: str, thread: str):
        d = self._dir(ns, thread)
        state, lock = d / "thread.state.json", d / "thread.lock"
        with _PROCESS_LOCKS[_stripe(("file", str(state)))], _file_lock(lock):
            rec = json.loads(state.read_text(encoding="utf-8")) if state.exists() else None
            txn = _Txn(rec)
            yield txn
            if txn.committed is not None:
                _write_atomically(state, dumps(txn.committed))

    def peek(self, ns: str, thread: str):
        state = self._dir(ns, thread) / "thread.state.json"
        return json.loads(state.read_text(encoding="utf-8")) if state.exists() else None

    def put_blob(self, ns: str, thread: str, name: str, value) -> None:
        _write_atomically(self._blob(ns, thread, name), dumps(value))

    def get_blob(self, ns: str, thread: str, name: str):
        p = self._blob(ns, thread, name)
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    def delete_blob(self, ns: str, thread: str, name: str) -> None:
        try:
            self._blob(ns, thread, name).unlink()
        except FileNotFoundError:
            pass


def store_for(sink):
    """The default store: beside the sink, so the record is as durable as the ledger.
    None when the sink's durability is unknown (the caller must then pass a store)."""
    if isinstance(sink, FileSink):
        return FileThreadStore(sink.root)
    if isinstance(sink, MemorySink):
        store = getattr(sink, "_polyflow_threads", None)
        if store is None:
            store = MemoryThreadStore()
            sink._polyflow_threads = store
        return store
    return None


def sink_holds_thread(sink, ns: str, thread: str) -> bool:
    """Does the sink already hold a chain for this thread? (A missing record then fails
    closed.) Asks the sink protocol's ``runs_of``; a sink without it is treated as
    holding the thread, so the answer fails CLOSED (the Governor refuses such a sink
    at guard level before it gets here)."""
    runs_of = getattr(sink, "runs_of", None)
    if sink is None:
        return False
    if not callable(runs_of):
        return True
    return bool(runs_of(ns, thread))
