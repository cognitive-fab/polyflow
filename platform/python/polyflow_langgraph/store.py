"""The per-thread governance record: the authority for a thread's chain and guard.

A LangGraph thread's chain head, guard state, decided turns and effect outcomes
live HERE, keyed by (ns, thread), never in the agent's message list (P10
review LG2-LG6): a message list is unauthenticated, is rewritten by trimming,
``update_state`` and time travel, and is not the thread (subagents each have
one). Every decision is a read-modify-write of this record inside
``transaction``, which serialises every worker on the thread, in this process
and across processes over the same directory (LG5, LG7).

Two stores, placed with the sink by default so the record is as durable as the
ledger it continues:

- ``MemoryThreadStore``: in process (tests, a ``MemorySink``);
- ``FileThreadStore(root)``: ``<root>/<ns>/<thread>/thread.state.json`` beside the
  ``FileSink``'s run files, written atomically under an OS file lock.
"""

from __future__ import annotations

import contextlib
import json
import os
import threading
import time
from pathlib import Path

from polyflow_temporal.sinks import FileSink, MemorySink, safe_component

_PROCESS_LOCKS: dict = {}
_PROCESS_LOCKS_GUARD = threading.Lock()


def _process_lock(key) -> threading.Lock:
    with _PROCESS_LOCKS_GUARD:
        return _PROCESS_LOCKS.setdefault(key, threading.Lock())


class _Txn:
    def __init__(self, record):
        self.record = record
        self.committed = None

    def commit(self, record: dict):
        self.committed = json.loads(json.dumps(record))  # JSON-shaped, and detached from the caller


class MemoryThreadStore:
    def __init__(self):
        self._records: dict = {}
        self._locks: dict = {}
        self._guard = threading.Lock()

    def _lock(self, key):
        with self._guard:
            return self._locks.setdefault(key, threading.Lock())

    @contextlib.contextmanager
    def transaction(self, ns: str, thread: str):
        key = (ns, thread)
        with self._lock(key):
            rec = self._records.get(key)
            txn = _Txn(json.loads(json.dumps(rec)) if rec is not None else None)
            yield txn
            if txn.committed is not None:
                self._records[key] = txn.committed

    def peek(self, ns: str, thread: str):
        rec = self._records.get((ns, thread))
        return json.loads(json.dumps(rec)) if rec is not None else None


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

    @contextlib.contextmanager
    def transaction(self, ns: str, thread: str):
        d = self._dir(ns, thread)
        state, lock = d / "thread.state.json", d / "thread.lock"
        with _process_lock(("file", str(state))), _file_lock(lock):
            rec = json.loads(state.read_text(encoding="utf-8")) if state.exists() else None
            txn = _Txn(rec)
            yield txn
            if txn.committed is not None:
                tmp = d / f"thread.state.{os.getpid()}.{threading.get_ident()}.tmp"
                tmp.write_text(json.dumps(txn.committed, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                os.replace(tmp, state)

    def peek(self, ns: str, thread: str):
        state = self._dir(ns, thread) / "thread.state.json"
        return json.loads(state.read_text(encoding="utf-8")) if state.exists() else None


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
    """Does the sink already hold a chain for this thread? (A missing record then fails closed.)"""
    if isinstance(sink, MemorySink):
        return any(k[0] == ns and k[1] == thread for k in sink.runs)
    if isinstance(sink, FileSink):
        d = sink.root.resolve() / safe_component(ns) / safe_component(thread)
        return d.is_dir() and any(p.name.endswith(".jsonl") and not p.name.endswith(".heads.jsonl") for p in d.iterdir())
    return False
