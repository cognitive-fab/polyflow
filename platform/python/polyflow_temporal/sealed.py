"""Sealed ledger headers (plan P2.6; NFR-7), ported from
platform/packages/kernel/src/sealed-header.mjs and pinned by
platform/conformance/sealed.json.

A header body (a ledger delta, or the head handed over at Continue-as-New) is
sealed with ChaCha20-Poly1305 under a worker-held data key, because Temporal's
payload codecs do not run on headers. Envelope::

    {polyflowSealed: 2, alg: "chacha20-poly1305", keyId, purpose, runId, seq, nonce, ct}

- plaintext = UTF-8 of the canonical JSON of the value;
- context   = "polyflow/<purpose>|<keyId>|<runId>|<seq>", the AAD (SEC-SH2);
- nonceKey  = HMAC-SHA-256(key, "polyflow-header-nonce-key");
- nonce     = HMAC-SHA-256(nonceKey, context + "\\n" + plaintext)[0:12]: a keyed
  synthetic IV, the same on every replay, different for different bodies (SEC-SH1).

Deterministic and pure, so workflow code seals and opens. The AEAD is the
``cryptography`` package's ChaCha20Poly1305 when it is installed, and a pure
Python RFC 8439 implementation otherwise (both are checked against the TS vectors).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re

from .canonical import canonical

SEALED_VERSION = 2
ALG = "chacha20-poly1305"
_NONCE_KEY_LABEL = b"polyflow-header-nonce-key"


class SealedHeaderError(ValueError):
    pass


# ---- base64, as the kernel writes and reads it -----------------------------------

def to_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def from_base64(text: str) -> bytes:
    """The kernel's fromBase64: lenient, ignores anything outside the alphabet."""
    clean = re.sub(r"[^A-Za-z0-9+/]", "", str(text))
    clean = clean[: len(clean) - len(clean) % 4] if len(clean) % 4 == 1 else clean
    return base64.b64decode(clean + "=" * (-len(clean) % 4))


def _utf8(text: str) -> bytes:
    return text.encode("utf-8", "surrogatepass")  # the kernel's utf8Bytes: code points, WTF-8 for lone surrogates


# ---- ChaCha20-Poly1305 (RFC 8439) --------------------------------------------------

def _rotl(v, n):
    return ((v << n) & 0xFFFFFFFF) | (v >> (32 - n))


def _block(key: bytes, counter: int, nonce: bytes) -> bytes:
    init = [0x61707865, 0x3320646E, 0x79622D32, 0x6B206574,
            *(int.from_bytes(key[i:i + 4], "little") for i in range(0, 32, 4)),
            counter & 0xFFFFFFFF,
            *(int.from_bytes(nonce[i:i + 4], "little") for i in range(0, 12, 4))]
    s = list(init)

    def q(a, b, c, d):
        s[a] = (s[a] + s[b]) & 0xFFFFFFFF; s[d] = _rotl(s[d] ^ s[a], 16)  # noqa: E702
        s[c] = (s[c] + s[d]) & 0xFFFFFFFF; s[b] = _rotl(s[b] ^ s[c], 12)  # noqa: E702
        s[a] = (s[a] + s[b]) & 0xFFFFFFFF; s[d] = _rotl(s[d] ^ s[a], 8)   # noqa: E702
        s[c] = (s[c] + s[d]) & 0xFFFFFFFF; s[b] = _rotl(s[b] ^ s[c], 7)   # noqa: E702
    for _ in range(10):
        q(0, 4, 8, 12); q(1, 5, 9, 13); q(2, 6, 10, 14); q(3, 7, 11, 15)  # noqa: E702
        q(0, 5, 10, 15); q(1, 6, 11, 12); q(2, 7, 8, 13); q(3, 4, 9, 14)  # noqa: E702
    return b"".join(((s[i] + init[i]) & 0xFFFFFFFF).to_bytes(4, "little") for i in range(16))


def _chacha20(key, counter, nonce, data: bytes) -> bytes:
    out = bytearray(len(data))
    for off in range(0, len(data), 64):
        ks = _block(key, counter + off // 64, nonce)
        chunk = data[off:off + 64]
        out[off:off + len(chunk)] = bytes(a ^ b for a, b in zip(chunk, ks))
    return bytes(out)


def _poly1305(key: bytes, msg: bytes) -> bytes:
    r = int.from_bytes(key[:16], "little") & 0x0FFFFFFC0FFFFFFC0FFFFFFC0FFFFFFF
    s = int.from_bytes(key[16:32], "little")
    p = (1 << 130) - 5
    acc = 0
    for i in range(0, len(msg), 16):
        chunk = msg[i:i + 16]
        acc = ((acc + int.from_bytes(chunk, "little") + (1 << (8 * len(chunk)))) * r) % p
    return ((acc + s) & ((1 << 128) - 1)).to_bytes(16, "little")


def _mac_data(aad: bytes, ct: bytes) -> bytes:
    pad = lambda n: b"\0" * ((16 - n % 16) % 16)  # noqa: E731
    return aad + pad(len(aad)) + ct + pad(len(ct)) + len(aad).to_bytes(8, "little") + len(ct).to_bytes(8, "little")


def _seal_py(key, nonce, plaintext, aad) -> bytes:
    ct = _chacha20(key, 1, nonce, plaintext)
    return ct + _poly1305(_block(key, 0, nonce)[:32], _mac_data(aad, ct))


def _open_py(key, nonce, sealed, aad) -> bytes | None:
    if len(sealed) < 16:
        return None
    ct, tag = sealed[:-16], sealed[-16:]
    if not hmac.compare_digest(_poly1305(_block(key, 0, nonce)[:32], _mac_data(aad, ct)), tag):
        return None
    return _chacha20(key, 1, nonce, ct)


try:  # the fast path, when the signing extra is installed
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

    def aead_seal(key, nonce, plaintext, aad) -> bytes:
        return ChaCha20Poly1305(key).encrypt(nonce, plaintext, aad)

    def aead_open(key, nonce, sealed, aad):
        try:
            return ChaCha20Poly1305(key).decrypt(nonce, sealed, aad)
        except InvalidTag:
            return None
    AEAD = "cryptography"
except ImportError:  # pragma: no cover — exercised by forcing the pure path in tests
    aead_seal, aead_open, AEAD = _seal_py, _open_py, "pure-python"


# ---- the header scheme ----------------------------------------------------------------

def _context(key_id: str, run_id: str, purpose: str, seq) -> str:
    from .canonical import js_str
    return f"polyflow/{purpose}|{key_id}|{run_id}|{js_str(seq)}"


def check_header_key(header_key: dict) -> bytes:
    key = from_base64(header_key.get("key", "")) if isinstance(header_key, dict) else b""
    if not (isinstance(header_key, dict) and isinstance(header_key.get("keyId"), str) and header_key["keyId"] and len(key) == 32):
        raise SealedHeaderError("a header key is { keyId, key: base64 of 32 bytes }")
    return key


def seal_header(value, header_key: dict, *, run_id: str, purpose: str, seq: int) -> dict:
    key = check_header_key(header_key)
    context = _context(header_key["keyId"], run_id, purpose, seq)
    plaintext = _utf8(canonical(value))
    nonce_key = hmac.new(key, _NONCE_KEY_LABEL, hashlib.sha256).digest()
    nonce = hmac.new(nonce_key, _utf8(context + "\n") + plaintext, hashlib.sha256).digest()[:12]
    sealed = aead_seal(key, nonce, plaintext, _utf8(context))
    return {"polyflowSealed": SEALED_VERSION, "alg": ALG, "keyId": header_key["keyId"], "purpose": purpose,
            "runId": run_id, "seq": seq, "nonce": to_base64(nonce), "ct": to_base64(sealed)}


def is_sealed(value) -> bool:
    return isinstance(value, dict) and value.get("polyflowSealed") == SEALED_VERSION


def open_header(value, keys: dict | None, *, required: bool = False, expect: dict | None = None):
    """Open a sealed header. ``keys`` maps keyId -> base64 key. With ``expect``
    ({runId?, purpose?}) the envelope must name that context. With ``required``,
    a plaintext header is refused too (SEC-EX2)."""
    if not is_sealed(value):
        if required:
            raise SealedHeaderError("the ledger header is not sealed, but this worker requires sealed headers: refused, not signed")
        return value
    k = (keys or {}).get(value.get("keyId"))
    if not k:
        raise SealedHeaderError(f"the ledger header is sealed with key '{value.get('keyId')}', which is not configured here")
    if expect and expect.get("runId") and value.get("runId") != expect["runId"]:
        raise SealedHeaderError(f"the ledger header was sealed for run {value.get('runId')}, not {expect['runId']}")
    if expect and expect.get("purpose") and value.get("purpose") != expect["purpose"]:
        raise SealedHeaderError(f"the ledger header was sealed as '{value.get('purpose')}', not '{expect['purpose']}'")
    context = _context(value["keyId"], value.get("runId"), value.get("purpose"), value.get("seq"))
    key, nonce = from_base64(k), from_base64(value.get("nonce", ""))
    out = aead_open(key, nonce, from_base64(value.get("ct", "")), _utf8(context)) if len(key) == 32 and len(nonce) == 12 else None
    if out is None:
        raise SealedHeaderError(f"the ledger header sealed with key '{value['keyId']}' does not open: tampered, or the wrong key")
    return json.loads(out.decode("utf-8", "surrogatepass"))
