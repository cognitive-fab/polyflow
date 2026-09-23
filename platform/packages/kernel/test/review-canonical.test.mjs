// Adversarial review (P0/P1): canonical JSON edge cases that broke the
// "a canonical text survives a round trip" and "one encoding per value" claims.
// They failed against the P1 implementation and are kept as regression tests;
// each names a finding in docs/platform/reviews/P0-P1-review.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, isCanonical } from '../src/index.mjs';

const DECOMPOSED = 'é'; // 'e' + COMBINING ACUTE -> NFC U+00E9
const COMPOSED = 'é';

// Finding K1: keys were sorted BEFORE they were NFC-normalised, so the emitted
// keys were not in sorted order once normalised.
test('review K1: canonical output is sorted by the keys it actually emits', () => {
  const text = canonical({ [DECOMPOSED]: 1, f: 2 });
  assert.equal(isCanonical(text), true, `canonical() produced non-canonical text ${text}`);
  assert.equal(text, `{"f":2,"${COMPOSED}":1}`);
});

// Finding K1 (b): two keys that differ only by normalisation collapsed to the
// same emitted key, producing JSON with a duplicate member name. Now refused.
test('review K1b: canonical never emits duplicate member names — it refuses the collision', () => {
  assert.throws(() => canonical({ [COMPOSED]: 1, [DECOMPOSED]: 2 }), /two keys normalise to/);
});
