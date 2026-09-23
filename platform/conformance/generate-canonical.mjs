// Generates conformance/canonical.json: inputs, their canonical text and digest,
// computed by the TypeScript kernel. Every other implementation (the Python
// port first) must reproduce `text` and `digest` byte for byte. Inputs are
// stored as JSON text so no loader can reinterpret them before the test.
import { writeFileSync } from 'node:fs';
import { canonical, digest } from '../packages/kernel/src/index.mjs';

const BS = '\\';
const cases = [
  ['empty object', '{}'],
  ['key order', '{"b":1,"a":2,"c":{"z":1,"y":2}}'],
  ['numbers at exponent boundaries', '[1e-7,1e-6,0.000001,1e20,1e21,1e16,1.0,1e-5,-0,0.1,123456789012345680000]'],
  ['float arithmetic result', '[0.30000000000000004]'],
  ['large and negative integers', '[9007199254740991,-9007199254740991,-1,0]'],
  ['strings needing escapes', `["quote${BS}"","back${BS}${BS}slash","tab${BS}t","nl${BS}n","ctl${BS}u0001","u2028${BS}u2028","u2029${BS}u2029"]`],
  ['non-ASCII is UTF-8, not escaped', '["é","€","日本"]'],
  ['astral keys sort by UTF-16 code unit', `{"${BS}uD83D${BS}uDE00":1,"${BS}uFF01":2,"a":3}`],
  ['NFC normalisation of values and keys', `{"e${BS}u0301":"e${BS}u0301"}`],
  ['nested arrays and nulls', '[null,[true,false,[]],{"a":null}]'],
];

const out = cases.map(([name, input]) => {
  const value = JSON.parse(input);
  return { name, input, text: canonical(value), digest: digest(value) };
});
out.push({ name: 'refused: keys that collide after NFC', input: `{"${BS}u00e9":1,"e${BS}u0301":2}`, refused: true });

writeFileSync(new URL('./canonical.json', import.meta.url), `${JSON.stringify({
  version: 1,
  rule: 'RFC 8785 number and string encoding; keys NFC-normalised, collisions refused, then sorted by UTF-16 code unit; -0 as 0; non-finite refused',
  cases: out,
}, null, 2)}\n`);
console.log(`wrote ${out.length} cases`);
