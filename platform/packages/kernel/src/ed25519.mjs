// Ed25519 signature VERIFICATION (RFC 8032), in pure JavaScript.
//
// It runs inside the Temporal workflow isolate, which has no `crypto`: an
// Update validator checks that the principal on an approval or a report was
// signed by a key the operator trusts (plan P5.5, verified principals). Only
// verification is here; signing happens outside, with node:crypto.
//
// BigInt arithmetic, extended twisted-Edwards coordinates. Not constant time,
// and it need not be: it handles public data only (a public key, a message, a
// signature). Pure and deterministic, so a replay reaches the same verdict.

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
const pow = (b, e, m = P) => {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
};
const inv = (a) => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

// ---- SHA-512 (FIPS 180-4), BigInt words ----
const M64 = (1n << 64n) - 1n;
const K512 = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
  'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2', '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
  'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
  '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df', '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
  'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec', '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
  'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817',
].map((h) => BigInt(`0x${h}`));
const H512 = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'].map((h) => BigInt(`0x${h}`));
const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & M64;

export function sha512(bytes) {
  const len = bytes.length;
  const padLen = ((len + 17 + 127) >> 7) << 7;
  const m = new Uint8Array(padLen);
  m.set(bytes);
  m[len] = 0x80;
  const bits = BigInt(len) * 8n;
  for (let i = 0; i < 16; i++) m[padLen - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  const h = H512.slice();
  const w = new Array(80);
  for (let off = 0; off < padLen; off += 128) {
    for (let i = 0; i < 16; i++) {
      let v = 0n;
      for (let j = 0; j < 8; j++) v = (v << 8n) | BigInt(m[off + i * 8 + j]);
      w[i] = v;
    }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr(w[i - 15], 1n) ^ rotr(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = rotr(w[i - 2], 19n) ^ rotr(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M64;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
      const ch = (e & f) ^ (~e & M64 & g);
      const t1 = (hh + S1 + ch + K512[i] + w[i]) & M64;
      const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & M64;
      hh = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64;
    }
    h[0] = (h[0] + a) & M64; h[1] = (h[1] + b) & M64; h[2] = (h[2] + c) & M64; h[3] = (h[3] + d) & M64;
    h[4] = (h[4] + e) & M64; h[5] = (h[5] + f) & M64; h[6] = (h[6] + g) & M64; h[7] = (h[7] + hh) & M64;
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((h[i] >> BigInt(56 - 8 * j)) & 0xffn);
  return out;
}

// ---- the curve ----
const leToInt = (bytes) => { let n = 0n; for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]); return n; };

// Points are [X, Y, Z, T] with x = X/Z, y = Y/Z, xy = T/Z.
function add([X1, Y1, Z1, T1], [X2, Y2, Z2, T2]) {
  const A = mod((Y1 - X1) * (Y2 - X2));
  const B = mod((Y1 + X1) * (Y2 + X2));
  const C = mod(2n * D * T1 * T2);
  const Dd = mod(2n * Z1 * Z2);
  const E = B - A; const F = Dd - C; const G = Dd + C; const H = B + A;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}
function mul(point, n) {
  let r = [0n, 1n, 1n, 0n];
  let q = point;
  while (n > 0n) { if (n & 1n) r = add(r, q); q = add(q, q); n >>= 1n; }
  return r;
}
/** A point whose order divides 8: [8]P is the identity. Such a key or R verifies forgeries (review SEC-ED1). */
const smallOrder = (p) => { let q = p; for (let i = 0; i < 3; i++) q = add(q, q); return mod(q[0]) === 0n && mod(q[1] - q[2]) === 0n; };

function equal([X1, Y1, Z1], [X2, Y2, Z2]) {
  return mod(X1 * Z2) === mod(X2 * Z1) && mod(Y1 * Z2) === mod(Y2 * Z1);
}
/** Decode a 32-byte point, or null if it is not on the curve. */
function decode(bytes) {
  if (bytes.length !== 32) return null;
  const b = bytes.slice();
  const sign = (b[31] >> 7) & 1;
  b[31] &= 0x7f;
  const y = leToInt(b);
  if (y >= P) return null;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 !== u) {
    if (vx2 === mod(-u)) x = mod(x * SQRT_M1);
    else return null;
  }
  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) x = mod(-x);
  return [x, y, 1n, mod(x * y)];
}
const GY = mod(4n * inv(5n));
const BASE = decode(Uint8Array.from({ length: 32 }, (_, i) => Number((GY >> BigInt(8 * i)) & 0xffn)));

// ---- encodings ----
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Strict base64: the canonical alphabet and padding only, or null (review SEC-ED2). */
export function fromBase64Strict(text) {
  const t = String(text);
  if (t.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(t)) return null;
  const out = fromBase64(t);
  // Unused trailing bits must be zero, or two strings decode to one value.
  const pad = t.endsWith('==') ? 2 : t.endsWith('=') ? 1 : 0;
  if (pad) { const last = B64.indexOf(t[t.length - pad - 1]); if ((pad === 2 ? last & 15 : last & 3) !== 0) return null; }
  return out;
}
export function fromBase64(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/]/g, '');
  const out = [];
  let buf = 0; let bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}
const utf8 = (s) => {
  const out = [];
  for (const ch of String(s)) {
    let c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else { out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
  }
  return Uint8Array.from(out);
};

const SPKI_ED25519 = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
/**
 * The raw 32-byte key from an ed25519 SPKI PEM (the form node:crypto exports),
 * or from base64 of the raw key; null for anything else (an X25519 or RSA
 * SPKI, a truncated PEM) — review SEC-ED2.
 */
export function publicKeyBytes(key) {
  const der = fromBase64Strict(String(key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  if (!der) return null;
  if (der.length === 32) return der;
  if (der.length === 44 && SPKI_ED25519.every((b, i) => der[i] === b)) return der.slice(12);
  return null;
}

/** A trust-store key that can verify something: well-formed, on the curve, not small-order. */
export function usablePublicKey(key) {
  const pub = publicKeyBytes(key);
  const A = pub && decode(pub);
  return Boolean(A && !smallOrder(A));
}

/**
 * @param {string|Uint8Array} message
 * @param {string} signatureB64
 * @param {string} publicKey  SPKI PEM, or base64 of the 32-byte key
 */
export function verifyEd25519(message, signatureB64, publicKey) {
  const sig = fromBase64Strict(signatureB64);
  if (!sig || sig.length !== 64) return false;
  const pub = publicKeyBytes(publicKey);
  if (!pub) return false;
  const A = decode(pub);
  const R = decode(sig.slice(0, 32));
  if (!A || !R || smallOrder(A) || smallOrder(R)) return false;
  const S = leToInt(sig.slice(32));
  if (S >= L) return false;
  const msg = typeof message === 'string' ? utf8(message) : message;
  const hin = new Uint8Array(64 + msg.length);
  hin.set(sig.slice(0, 32)); hin.set(pub, 32); hin.set(msg, 64);
  const h = mod(leToInt(sha512(hin)), L);
  return equal(mul(BASE, S), add(R, mul(A, h)));
}
