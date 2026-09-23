"""Ledger sinks and head signing: where a governed run's record lands.

Engine-neutral (no Temporal import): the Temporal plugin's exporter and the
LangGraph binding (polyflow_langgraph) both write through these. The file
layout is the TypeScript fileSink's, so `polyflow verify` reads either.
"""

from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path

from .ledger import genesis


def _load_signer(key: dict):
    """The Ed25519 key a worker signs heads with. A configured key that cannot sign
    is an error, never a silently unsigned ledger (install `polyflow-temporal[signing]`)."""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import load_pem_private_key
    except ImportError as err:
        raise ImportError("signing_key is set but the 'cryptography' package is not installed: "
                          "pip install 'polyflow-temporal[signing]'") from err
    if not isinstance(key, dict) or not key.get("keyId") or not key.get("privateKeyPem"):
        raise ValueError("signing_key needs { keyId, privateKeyPem } (as `polyflow keygen` writes it)")
    pk = load_pem_private_key(key["privateKeyPem"].encode(), password=None)
    if not isinstance(pk, Ed25519PrivateKey):
        raise ValueError(f"signing key '{key['keyId']}' is not an Ed25519 key")
    return pk


def head_message(run: dict, head: dict) -> bytes:
    """The bytes a head signature covers: the TypeScript `headMessage`, byte for byte."""
    return f"polyflow-head\n{run['ns']}\n{run['wf']}\n{run['run']}\n{head['seq']}\n{head['hash']}".encode()


def sign_head(run: dict, head: dict, key: dict | None):
    """A signed head record for a verified head (None without a key): what `polyflow verify` checks."""
    if not key:
        return None
    sig = _load_signer(key).sign(head_message(run, head))
    return {"run": run, "seq": head["seq"], "hash": head["hash"], "keyId": key["keyId"], "alg": "ed25519", "sig": base64.b64encode(sig).decode()}


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


_sign = sign_head  # the name the Temporal plugin has always used


def _jsonl(value) -> str:
    """One JSON line, as JSON.stringify writes it: non-ASCII raw, a lone surrogate
    (redaction can truncate between the halves of a pair, as TS does) escaped."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", text)


def _no_write() -> dict:
    return {"written": 0, "skipped": 0, "conflicts": []}


def partition_delta(events: list, held) -> dict:
    """Split a delta against what a sink holds for its run (the TS ``partitionDelta``).

    ``held(seq)`` returns ``{"hash", "prev"}`` or None. A different event at a
    held seq is a conflict; a new event that does not chain from the held event
    before it, or that a held event after it does not chain from, is a fork.
    Either way the delta is refused WHOLE: nothing of it is written, so a fork
    is never stored on top of the real chain (P6-P8 SV6; P9 SEC-PY1).
    """
    fresh, conflicts, skipped = [], [], 0
    for e in events:
        had = held(e["seq"])
        if had is None:
            fresh.append(e)
        elif had["hash"] == e["hash"]:
            skipped += 1
        else:
            conflicts.append(e["seq"])
    if not conflicts:
        is_fresh = {e["seq"] for e in fresh}
        for e in fresh:
            before = {"hash": genesis(e["run"])} if e["seq"] == 0 else held(e["seq"] - 1)
            if before and (e["seq"] - 1) not in is_fresh and e["prev"] != before["hash"]:
                conflicts.append(e["seq"])
            after = None if (e["seq"] + 1) in is_fresh else held(e["seq"] + 1)
            if after and after.get("prev") is not None and after["prev"] != e["hash"]:
                conflicts.append(e["seq"] + 1)
    if conflicts:
        return {"fresh": [], "skipped": 0, "conflicts": sorted(set(conflicts))}
    return {"fresh": fresh, "skipped": skipped, "conflicts": []}


def _contiguous_head(seen: dict):
    seq = -1
    while seq + 1 in seen:
        seq += 1
    return None if seq < 0 else {"seq": seq, "hash": seen[seq]["hash"]}


_SAFE_CHAR = re.compile(r"[A-Za-z0-9_-]")


def safe_component(s) -> str:
    """A path component that cannot escape or collide: every UTF-8 byte outside
    [A-Za-z0-9_-] (``.``, ``~`` and ``%`` included) becomes ``~`` + two upper-case
    hex digits; an empty component is ``~``. Injective, and never ``.``/``..`` (P9 SEC-FS1/PY2).
    The TypeScript file sink uses the same encoding, so both name files alike."""
    # Node's Buffer.from(s, 'utf-8') writes a lone surrogate as U+FFFD: so do we.
    data = "".join("�" if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in str(s)).encode("utf-8")
    return "".join(chr(b) if _SAFE_CHAR.fullmatch(chr(b)) else f"~{b:02X}" for b in data) or "~"


class FileSink:
    """JSONL per run, the same layout as the TypeScript fileSink, so `polyflow verify` reads it.

    Idempotent on (run, seq): an event it already holds is skipped if identical.
    A delta with a different event at a held seq, or one that forks the held
    chain, is refused whole and REPORTED (``{"conflicts": [seq, ...]}``): that is
    what tampering, or a split brain, looks like. One writer process per run
    directory, as in TypeScript. The cache of what a run file holds is re-read
    when the file changed under it (another process appended; P10 review LG7),
    so a stale cache never re-appends events another writer wrote.
    """

    def __init__(self, root: str | os.PathLike):
        self.root = Path(root)
        self._known: dict = {}  # (ns, wf, run) -> {seq: {"hash", "prev"}}
        self._sizes: dict = {}  # (ns, wf, run) -> the run file's size when last read or written

    _safe = staticmethod(safe_component)

    def paths(self, run: dict):
        root = self.root.resolve()
        d = root / safe_component(run["ns"]) / safe_component(run["wf"])
        ev, hd = d / f"{safe_component(run['run'])}.jsonl", d / f"{safe_component(run['run'])}.heads.jsonl"
        for p in (d, ev, hd):
            if root not in p.resolve().parents:
                raise ValueError(f"ledger path for {run!r} resolves outside the sink root: refused")
        return d, ev, hd

    @staticmethod
    def _read_jsonl(path: Path) -> list:
        out = []
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        continue  # non-strict, as the TS sink: a verifier reads strictly
        return out

    @staticmethod
    def _size(path: Path):
        try:
            return path.stat().st_size
        except OSError:
            return None

    def _seen(self, run: dict) -> dict:
        k = (run["ns"], run["wf"], run["run"])
        ev = self.paths(run)[1]
        if k in self._known and self._sizes.get(k) != self._size(ev):
            del self._known[k]  # another writer changed the file: re-read it
        if k not in self._known:
            self._sizes[k] = self._size(ev)
            # Only this run's events count, whatever else the file holds.
            self._known[k] = {e["seq"]: {"hash": e["hash"], "prev": e.get("prev")}
                              for e in self._read_jsonl(self.paths(run)[1])
                              if isinstance(e, dict) and e.get("run") == run and isinstance(e.get("seq"), int)}
        return self._known[k]

    def write(self, events: list, signed) -> dict:
        if not events:
            return _no_write()
        run = events[0]["run"]
        seen = self._seen(run)
        d, ev, hd = self.paths(run)
        part = partition_delta(events, seen.get)
        fresh = part["fresh"]
        if fresh:
            d.mkdir(parents=True, exist_ok=True)
            for e in fresh:
                seen[e["seq"]] = {"hash": e["hash"], "prev": e["prev"]}
            with ev.open("a", encoding="utf-8") as f:
                f.write("".join(_jsonl(e) + "\n" for e in fresh))
            self._sizes[(run["ns"], run["wf"], run["run"])] = self._size(ev)
            if signed:
                with hd.open("a", encoding="utf-8") as f:
                    f.write(_jsonl(signed) + "\n")
        return {"written": len(fresh), "skipped": part["skipped"], "conflicts": part["conflicts"]}

    def head(self, run: dict):
        """The highest contiguous event this sink holds for a run, or None."""
        return _contiguous_head(self._seen(run))

    def read(self, run: dict):
        _, ev, hd = self.paths(run)
        return sorted((e for e in self._read_jsonl(ev) if e.get("run") == run), key=lambda e: e["seq"]), self._read_jsonl(hd)


class MemorySink:
    def __init__(self):
        self.runs: dict = {}

    def write(self, events, signed) -> dict:
        if not events:
            return _no_write()
        r = self.runs.setdefault((events[0]["run"]["ns"], events[0]["run"]["wf"], events[0]["run"]["run"]), {"events": {}, "heads": []})
        part = partition_delta(events, r["events"].get)
        for e in part["fresh"]:
            r["events"][e["seq"]] = e
        if signed and part["fresh"]:
            r["heads"].append(signed)
        return {"written": len(part["fresh"]), "skipped": part["skipped"], "conflicts": part["conflicts"]}

    def head(self, run: dict):
        r = self.runs.get((run["ns"], run["wf"], run["run"]))
        return _contiguous_head(r["events"]) if r else None

    def read(self, wf):
        for (ns, w, run), r in self.runs.items():
            if w == wf:
                return [r["events"][k] for k in sorted(r["events"])], r["heads"]
        return [], []
