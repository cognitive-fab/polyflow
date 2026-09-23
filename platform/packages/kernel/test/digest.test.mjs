import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { canonical, isCanonical, CanonicalError, sha256hex, utf8, digest, digestText } from '../src/index.mjs';

test('sha256 matches the NIST vectors', () => {
  assert.equal(sha256hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  assert.equal(
    sha256hex('a'.repeat(1_000_000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  );
});

test('sha256 agrees with node:crypto on random inputs of every padding length', () => {
  for (let len = 0; len < 200; len++) {
    const b = randomBytes(len);
    assert.equal(sha256hex(b), createHash('sha256').update(b).digest('hex'), `length ${len}`);
  }
});

test('utf8 agrees with TextEncoder, including astral characters and lone surrogates', () => {
  for (const s of ['', 'abc', 'é', '€', '𝄞 clef', 'mixed é€𝄞', '\ud800 lone', 'x\udc00']) {
    assert.deepEqual([...utf8(s)], [...new TextEncoder().encode(s)], JSON.stringify(s));
  }
});

test('canonical sorts keys, drops undefined fields and has no whitespace', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'x'], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(canonical({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
});

test('canonical: -0 is 0, and non-finite numbers are refused', () => {
  assert.equal(canonical(-0), '0');
  assert.throws(() => canonical(NaN), CanonicalError);
  assert.throws(() => canonical({ a: Infinity }), /non-finite number Infinity at \.a/);
});

test('canonical refuses what has no single encoding', () => {
  assert.throws(() => canonical([1, undefined]), /undefined in array at \[1\]/);
  assert.throws(() => canonical(new Date(0)), /not a plain object \(Date\)/);
  assert.throws(() => canonical(new Map()), CanonicalError);
  assert.throws(() => canonical(() => 1), /unsupported type function/);
  assert.throws(() => canonical(1n), /unsupported type bigint/);
});

test('canonical NFC-normalises strings, so two spellings of é digest the same', () => {
  const composed = 'é';
  const decomposed = 'é';
  assert.equal(digest({ [composed]: composed }), digest({ [decomposed]: decomposed }));
});

test('a canonical text survives a round trip; a non-canonical one does not', () => {
  assert.equal(isCanonical('{"a":1,"b":2}'), true);
  assert.equal(isCanonical('{"b":2,"a":1}'), false);
  assert.equal(isCanonical('{"a": 1}'), false);
});

test('digest is stable and key-order independent', () => {
  const a = digest({ run: 'r', seq: 1, body: { x: 1, y: [1, 2] } });
  const b = digest({ body: { y: [1, 2], x: 1 }, seq: 1, run: 'r' });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('digestText hashes a CRLF checkout the same as an LF one', () => {
  assert.equal(digestText('line1\r\nline2\r\n'), digestText('line1\nline2\n'));
});
