"""The decision ledger: a per-run hash chain, byte-for-byte with the TS kernel
(platform/packages/kernel/src/ledger.mjs). Pure: runs in workflow code."""

from __future__ import annotations

import math

from .canonical import digest

KINDS = ("admission", "proposal", "verdict", "effect", "observation", "closure")


def genesis(run: dict) -> str:
    return digest({"genesis": {"ns": run["ns"], "wf": run["wf"], "run": run["run"]}})


def hash_of(event: dict) -> str:
    rest = {k: v for k, v in event.items() if k != "hash"}
    return digest(rest)


class Ledger:
    def __init__(self, run: dict, head: dict | None = None):
        if not isinstance(run.get("wf"), str) or not isinstance(run.get("run"), str):
            raise ValueError("a ledger needs run = { ns, wf, run } with string wf and run")
        self.run = {"ns": str(run.get("ns") or "default"), "wf": run["wf"], "run": run["run"]}
        self._seq = head["seq"] if head else -1
        self._prev = head["hash"] if head else genesis(self.run)
        self._buffer: list[dict] = []
        self._all: list[dict] = []

    def append(self, kind: str, body: dict | None, at) -> dict:
        if kind not in KINDS:
            raise ValueError(f"unknown ledger event kind '{kind}'")
        if not isinstance(at, (int, float)) or not math.isfinite(at):
            raise ValueError("ledger events need a finite workflow time `at`")
        event = {"v": 1, "run": dict(self.run), "seq": self._seq + 1, "kind": kind, "at": at, "body": body or {}, "prev": self._prev}
        event["hash"] = hash_of(event)
        self._seq = event["seq"]
        self._prev = event["hash"]
        self._buffer.append(event)
        self._all.append(event)
        return event

    def head(self) -> dict | None:
        return None if self._seq < 0 else {"seq": self._seq, "hash": self._prev}

    def drain(self) -> list[dict]:
        out, self._buffer = self._buffer, []
        return out

    def pending(self) -> int:
        return len(self._buffer)

    def events(self) -> list[dict]:
        return list(self._all)


def verify_chain(events: list[dict], start: dict | None = None) -> dict:
    if not events:
        return {"ok": False, "seq": None, "reason": "empty ledger"}
    run = events[0]["run"]
    seq = start["seq"] if start else -1
    prev = start["hash"] if start else genesis(run)
    for e in events:
        if e.get("run") != run:
            return {"ok": False, "seq": e.get("seq"), "reason": "event belongs to another run"}
        if e.get("seq") != seq + 1:
            return {"ok": False, "seq": seq + 1, "reason": "missing event" if (e.get("seq") or 0) > seq + 1 else "out of order"}
        if e.get("v") != 1 or e.get("kind") not in KINDS:
            return {"ok": False, "seq": e["seq"], "reason": "unsupported event"}
        if e.get("prev") != prev:
            return {"ok": False, "seq": e["seq"], "reason": "prev does not match the preceding event"}
        if hash_of(e) != e.get("hash"):
            return {"ok": False, "seq": e["seq"], "reason": "hash does not match content"}
        seq, prev = e["seq"], e["hash"]
    return {"ok": True, "head": {"seq": seq, "hash": prev}, "count": len(events)}
