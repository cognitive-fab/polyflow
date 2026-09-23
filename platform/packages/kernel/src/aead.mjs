// ChaCha20-Poly1305 (RFC 8439) ENCRYPTION, in pure JavaScript — plan P2.6.
//
// Temporal's payload codecs do not run on headers (the SDK visits payloads
// with `skipHeaders: true`), so the ledger delta a workflow carries on an
// activity header would sit in history in plaintext, outside the customer's
// codec (NFR-7). The workflow isolate has no `crypto`, so the header body is
// sealed here, in pure JS, with a data key the worker holds (typically
// unwrapped from the customer's KMS at worker start). The exporter, the next
// execution and `polyflow export` open it with the same key.
//
// The nonce is derived, not random: it must be the same on every replay of
// the same workflow task, and unique per key. It is derived from the run id,
// the ledger head sequence and the header's purpose, which never repeat
// together for one key.

const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;

function quarter(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
}

function block(key, counter, nonce) {
  const init = new Uint32Array(16);
  init[0] = 0x61707865; init[1] = 0x3320646e; init[2] = 0x79622d32; init[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) init[4 + i] = u32(key, i * 4);
  init[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) init[13 + i] = u32(nonce, i * 4);
  const s = Uint32Array.from(init);
  for (let i = 0; i < 10; i++) {
    quarter(s, 0, 4, 8, 12); quarter(s, 1, 5, 9, 13); quarter(s, 2, 6, 10, 14); quarter(s, 3, 7, 11, 15);
    quarter(s, 0, 5, 10, 15); quarter(s, 1, 6, 11, 12); quarter(s, 2, 7, 8, 13); quarter(s, 3, 4, 9, 14);
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const v = (s[i] + init[i]) >>> 0;
    out[i * 4] = v & 0xff; out[i * 4 + 1] = (v >>> 8) & 0xff; out[i * 4 + 2] = (v >>> 16) & 0xff; out[i * 4 + 3] = v >>> 24;
  }
  return out;
}

function chacha20(key, counter, nonce, data) {
  const out = new Uint8Array(data.length);
  for (let off = 0, c = counter; off < data.length; off += 64, c++) {
    const ks = block(key, c, nonce);
    for (let i = 0; i < 64 && off + i < data.length; i++) out[off + i] = data[off + i] ^ ks[i];
  }
  return out;
}

const leBig = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const P1305 = (1n << 130n) - 5n;

function poly1305(key, msg) {
  const r = leBig(key.slice(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leBig(key.slice(16, 32));
  let acc = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const chunk = msg.slice(i, i + 16);
    const n = leBig(chunk) + (1n << BigInt(8 * chunk.length));
    acc = ((acc + n) * r) % P1305;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) { tag[i] = Number(acc & 0xffn); acc >>= 8n; }
  return tag;
}

const pad16 = (n) => (16 - (n % 16)) % 16;
const le64 = (n) => { const b = new Uint8Array(8); let v = BigInt(n); for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };

function macData(aad, ct) {
  const out = new Uint8Array(aad.length + pad16(aad.length) + ct.length + pad16(ct.length) + 16);
  let o = 0;
  out.set(aad, o); o += aad.length + pad16(aad.length);
  out.set(ct, o); o += ct.length + pad16(ct.length);
  out.set(le64(aad.length), o); out.set(le64(ct.length), o + 8);
  return out;
}

/** Seal `plaintext` under a 32-byte key and a 12-byte nonce. Returns ciphertext || 16-byte tag. */
export function seal(key, nonce, plaintext, aad = new Uint8Array(0)) {
  if (key.length !== 32 || nonce.length !== 12) throw new Error('chacha20-poly1305 needs a 32-byte key and a 12-byte nonce');
  const polyKey = block(key, 0, nonce).slice(0, 32);
  const ct = chacha20(key, 1, nonce, plaintext);
  const tag = poly1305(polyKey, macData(aad, ct));
  const out = new Uint8Array(ct.length + 16);
  out.set(ct); out.set(tag, ct.length);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}

export function utf8Bytes(text) {
  const out = [];
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** Open what `seal` produced, or return null when the tag does not verify. */
export function open(key, nonce, sealed, aad = new Uint8Array(0)) {
  if (key.length !== 32 || nonce.length !== 12 || sealed.length < 16) return null;
  const ct = sealed.slice(0, sealed.length - 16);
  const tag = sealed.slice(sealed.length - 16);
  const expect = poly1305(block(key, 0, nonce).slice(0, 32), macData(aad, ct));
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= expect[i] ^ tag[i];
  if (diff !== 0) return null;
  return chacha20(key, 1, nonce, ct);
}

export function utf8Text(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let c; let n;
    if (b < 0x80) { c = b; n = 1; } else if (b < 0xe0) { c = ((b & 31) << 6) | (bytes[i + 1] & 63); n = 2; } else if (b < 0xf0) { c = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); n = 3; } else { c = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); n = 4; }
    out += String.fromCodePoint(c);
    i += n;
  }
  return out;
}
