// Sealed ledger headers — plan P2.6; NFR-7.
//
// A header body (a ledger delta, or the head handed over at Continue-as-New)
// sealed with ChaCha20-Poly1305 under a worker-held data key. Pure, so the
// workflow isolate seals and opens it.
//
// The nonce is a SYNTHETIC IV (P9 security review SEC-SH1): HMAC-SHA-256 under
// a nonce key derived from the data key, over the context and the plaintext.
// It is the same on every replay of the same workflow task (same plaintext),
// and different whenever the plaintext differs — a worker upgrade that
// re-seals a seq with other events no longer reuses a (key, nonce) pair. It is
// keyed, so a reader of history cannot confirm a guess of the plaintext.
// The context (key id, run, purpose, seq) is bound into the AAD (SEC-SH2), so
// a sealed body from one run does not open as another's.
import { seal, open, toBase64, utf8Bytes, utf8Text } from './aead.mjs';
import { fromBase64 } from './ed25519.mjs';
import { sha256hex } from './sha256.mjs';
import { canonical } from './canonical.mjs';

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** HMAC-SHA-256 (RFC 2104) over bytes. */
export function hmacSha256(key, msg) {
  let k = key.length > 64 ? hexBytes(sha256hex(key)) : key;
  k = concat(k, new Uint8Array(64 - k.length));
  const ipad = k.map((b) => b ^ 0x36);
  const opad = k.map((b) => b ^ 0x5c);
  return hexBytes(sha256hex(concat(opad, hexBytes(sha256hex(concat(ipad, msg))))));
}

const contextOf = (keyId, { runId, purpose, seq }) => `polyflow/${purpose}|${keyId}|${runId}|${seq}`;

/**
 * @param {object} value          what the header would carry in plaintext
 * @param {{ keyId: string, key: string }} headerKey  key: base64 of 32 bytes
 * @param {{ runId: string, purpose: string, seq: number }} at
 */
export function sealHeader(value, headerKey, { runId, purpose, seq }) {
  const key = fromBase64(headerKey.key);
  const context = contextOf(headerKey.keyId, { runId, purpose, seq });
  const plaintext = utf8Bytes(canonical(value));
  const nonceKey = hmacSha256(key, utf8Bytes('polyflow-header-nonce-key'));
  const nonce = hmacSha256(nonceKey, concat(utf8Bytes(`${context}\n`), plaintext)).slice(0, 12);
  const sealed = seal(key, nonce, plaintext, utf8Bytes(context));
  return { polyflowSealed: 2, alg: 'chacha20-poly1305', keyId: headerKey.keyId, purpose, runId, seq, nonce: toBase64(nonce), ct: toBase64(sealed) };
}

export const isSealed = (v) => Boolean(v && typeof v === 'object' && v.polyflowSealed === 2);

/**
 * Open a sealed header. `keys` maps keyId -> base64 key. With `expect`
 * ({ runId?, purpose? }), the envelope must name that context. Throws when the
 * key is unknown, the context differs, or the tag does not verify. With
 * `required`, a plaintext header is refused too (SEC-EX2): where a key is
 * configured, an unsealed header came from something that does not hold it.
 */
export function openHeader(value, keys, { required = false, expect = null } = {}) {
  if (!isSealed(value)) {
    if (required) throw new Error('the ledger header is not sealed, but this worker requires sealed headers: refused, not signed');
    return value;
  }
  const k = keys?.[value.keyId];
  if (!k) throw new Error(`the ledger header is sealed with key '${value.keyId}', which is not configured here`);
  if (expect?.runId && value.runId !== expect.runId) throw new Error(`the ledger header was sealed for run ${value.runId}, not ${expect.runId}`);
  if (expect?.purpose && value.purpose !== expect.purpose) throw new Error(`the ledger header was sealed as '${value.purpose}', not '${expect.purpose}'`);
  const context = contextOf(value.keyId, value);
  const out = open(fromBase64(k), fromBase64(value.nonce), fromBase64(value.ct), utf8Bytes(context));
  if (!out) throw new Error(`the ledger header sealed with key '${value.keyId}' does not open: tampered, or the wrong key`);
  return JSON.parse(utf8Text(out));
}
