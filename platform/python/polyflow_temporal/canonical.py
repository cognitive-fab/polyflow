"""Canonical JSON and digests, byte-for-byte with the TypeScript kernel.

The rules (platform/packages/kernel/src/canonical.mjs, pinned by
platform/conformance/canonical.json):

- numbers and strings encoded as RFC 8785 (JCS) encodes them: ECMAScript
  Number::toString for numbers; only the mandatory string escapes, non-ASCII
  emitted as UTF-8
- object keys NFC-normalised, collisions refused, then sorted by UTF-16 code
  unit (NOT by code point: the two orders differ above U+FFFF)
- no whitespace; finite numbers only; -0 as 0
- string values NFC-normalised

Pure standard library, so it runs unchanged inside the Temporal Python sandbox.
"""

from __future__ import annotations

import hashlib
import math
import unicodedata
from decimal import Decimal


class CanonicalError(ValueError):
    pass


def _es_number(x) -> str:
    """ECMAScript Number::toString for a finite number."""
    if isinstance(x, bool):
        raise CanonicalError("a boolean is not a number")
    if isinstance(x, int):
        if abs(x) >= 2**53:
            # JS would already have rounded it: refuse rather than disagree.
            x = float(x)
        else:
            return str(x)
    if not math.isfinite(x):
        raise CanonicalError(f"non-finite number {x}")
    if x == 0:
        return "0"
    if x < 0:
        return "-" + _es_number(-x)
    if x == int(x) and x < 2**53:
        return str(int(x))  # exact below 2^53; above it, ES prints shortest digits then zeros
    # Shortest round-trip digits (Python's repr is shortest-round-trip, as ES is).
    sign, digits, exponent = Decimal(repr(x)).as_tuple()
    ds = "".join(str(d) for d in digits).rstrip("0") or "0"
    # repr may have stripped zeros into the exponent; recompute n so value = 0.ds * 10^n
    n = len("".join(str(d) for d in digits)) + exponent
    k = len(ds)
    if k <= n <= 21:
        return ds + "0" * (n - k)
    if 0 < n <= 21:
        return ds[:n] + "." + ds[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + ds
    e = n - 1
    exp = ("+" if e >= 0 else "-") + str(abs(e))
    return (ds if k == 1 else ds[0] + "." + ds[1:]) + "e" + exp


_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _es_string(s: str) -> str:
    """JSON.stringify of a string (well-formed: lone surrogates escaped)."""
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif o < 0x20:
            out.append(f"\\u{o:04x}")
        elif 0xD800 <= o <= 0xDFFF:
            out.append(f"\\u{o:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(s: str) -> bytes:
    return s.encode("utf-16-be", "surrogatepass")


def _nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def _encode(v, path: str) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return _es_number(v)
    if isinstance(v, str):
        return _es_string(_nfc(v))
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(_encode(x, f"{path}[{i}]") for i, x in enumerate(v)) + "]"
    if isinstance(v, dict):
        entries = {}
        for k, val in v.items():
            if not isinstance(k, str):
                raise CanonicalError(f"non-string key at {path or '$'}")
            nk = _nfc(k)
            if nk in entries:
                raise CanonicalError(f"two keys normalise to {_es_string(nk)} at {path or '$'}")
            entries[nk] = val
        keys = sorted(entries, key=_utf16_key)
        return "{" + ",".join(f"{_es_string(k)}:{_encode(entries[k], f'{path}.{k}')}" for k in keys) + "}"
    raise CanonicalError(f"unsupported type {type(v).__name__} at {path or '$'}")


def canonical(value) -> str:
    return _encode(value, "")


def sha256hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def digest(value) -> str:
    return "sha256:" + sha256hex(canonical(value))


def js_str(v) -> str:
    """How a JS template literal prints a number or string: used in fix sentences."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return _es_number(v)
    return str(v)
