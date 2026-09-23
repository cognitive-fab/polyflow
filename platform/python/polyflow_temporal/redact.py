"""Secret redaction before anything is recorded (FR-LED.5), ported from
platform/packages/kernel/src/redact.mjs and pinned by
platform/conformance/parity.json: redact first, then truncate.

The observation body that carries this text is hashed into the ledger, so the
port must produce the TypeScript string exactly:

- JavaScript's ``\\b`` is ASCII-only: every pattern runs under ``re.ASCII``;
- JavaScript's ``\\s`` is Unicode whitespace: it is spelled out below, since
  ``re.ASCII`` would narrow Python's ``\\s``;
- ``/i`` without ``/u`` folds ASCII letters only (as ``re.ASCII | re.I`` does);
- ``length`` and ``slice`` count UTF-16 code units, not code points.

Pure standard library: runs inside the Temporal Python sandbox.
"""

from __future__ import annotations

import re

# ECMAScript WhiteSpace and LineTerminator (what `\s` matches in a JS RegExp).
_WS = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"

_A = re.ASCII
_AI = _A | re.IGNORECASE
SECRETS = (
    # Order matters (as in TS): the multi-line and URL shapes run first, so a
    # later key=value rule never splits them (P9 security review SEC-RD1).
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----", _A),
    re.compile(r"\b[a-z][a-z0-9+.-]*://[^" + _WS + r":@/]+:[^" + _WS + r"@/]+@", _AI),
    re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+", _A),
    re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}", _A),
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}", _A),
    re.compile(r"\bBasic[" + _WS + r"]+[A-Za-z0-9+/=]{8,}", _AI),
    re.compile(r"\"(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret)\"[" + _WS + r"]*:[" + _WS + r"]*\"[^\"]*\"", _AI),
    re.compile(r"\b(?:password|passwd|secret|token|api[_-]?key)[" + _WS + r"]*:[" + _WS + r"]*[^" + _WS + r",;\"']+", _AI),
    re.compile(r"\bsk-ant-[A-Za-z0-9_-]{8,}", _A),
    re.compile(r"\bsk-[A-Za-z0-9]{20,}", _A),
    re.compile(r"\b[sr]k[-_](?:live|test)[-_][A-Za-z0-9]{10,}", _A),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}", _A),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}", _A),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b", _A),
    re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}", _A),
    re.compile(r"\bBearer[" + _WS + r"]+[A-Za-z0-9._~+/=-]{16,}", _A | re.IGNORECASE),
    re.compile(r"\b(?:password|passwd|secret|token|api[_-]?key)=[^" + _WS + r"&\"']+", _A | re.IGNORECASE),
)

MARKER = "…"  # the truncation marker, as TS writes it


def _utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def _utf16_slice(s: str, n: int) -> str:
    """``s.slice(0, n)`` in JavaScript: may end on a lone high surrogate, as JS does."""
    return s.encode("utf-16-le", "surrogatepass")[: 2 * n].decode("utf-16-le", "surrogatepass")


def redact(text, max: int = 200) -> str:  # noqa: A002 — the TS parameter name
    s = "" if text is None else str(text)
    for pattern in SECRETS:
        s = pattern.sub("[redacted]", s)
    return _utf16_slice(s, max) + MARKER if _utf16_len(s) > max else s
