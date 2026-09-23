// Generates conformance/parity.json: two kernel behaviours the Python port
// diverged on (P6-P8 review PYC1, PY2), computed by the TypeScript kernel.
//
// - pick: what a metered budget reads from an activity result at a `from`
//   path. Arrays by decimal index and `length`, strings by UTF-16 unit and
//   `length`. Recorded as the meter the guard holds after one observation.
// - redact: failure text as it is recorded (redact, then truncate to 200
//   UTF-16 units with the marker). The observation body is hashed, so the
//   string must match exactly.
//
// Inputs are stored as JSON text so no loader can reinterpret them first.
import { writeFileSync } from 'node:fs';
import { createGuard, redact } from '../packages/kernel/src/index.mjs';

const BS = '\\';

const pickCases = [
  ['array index then key', '{"items":[{"n":2}]}', 'items.0.n'],
  ['array length', '{"a":[1,2,3]}', 'a.length'],
  ['top-level array index', '[7,8]', '1'],
  ['nested arrays', '[[1,[2,3]]]', '0.1.1'],
  ['non-canonical index', '{"a":[1,2,3]}', 'a.01'],
  ['negative index', '{"a":[1,2,3]}', 'a.-1'],
  ['index past the end', '{"a":[1]}', 'a.1'],
  ['exponent index', '{"a":[1,2]}', 'a.1e0'],
  ['object with a numeric key', '{"a":{"0":4}}', 'a.0'],
  ['string length', '"hello"', 'length'],
  ['string length in UTF-16 units', `"${BS}uD83D${BS}uDE00x"`, 'length'],
  ['nested string length', '{"s":"abc"}', 's.length'],
  ['string index then length', '"abc"', '0.length'],
  ['astral string index then length', `"${BS}uD83D${BS}uDE00"`, '0.length'],
  ['string index is not a number', '"123"', '0'],
  ['numeric string', '{"usd":"5"}', 'usd'],
  ['boolean', '{"usd":true}', 'usd'],
  ['a number has no keys', '5', 'x'],
  ['null result', 'null', 'usd'],
  ['through null', '{"a":null}', 'a.b'],
  ['fractional', '{"usd":2.5}', 'usd'],
  ['plain key', '{"usd":5}', 'usd'],
];

const pick = pickCases.map(([name, result, from]) => {
  const policy = {
    policy: 'p', version: 1, digest: 'sha256:x', unlabelled: 'deny', kinds: ['model'],
    effects: { llm: { kind: 'model', class: 'none', labels: [] } },
    rules: [{ id: 'm', type: 'budget', metric: 'm', from, max: 1e9, outcome: 'deny' }],
  };
  const g = createGuard(policy);
  const s = g.observe(g.init(), { kind: 'model', ok: true, labels: [], result: JSON.parse(result) });
  return { name, result, from, meter: s.meters.m ?? null };
});

const redactCases = [
  ['credential in an upstream error', 'upstream rejected the call: api_key=sk-live-0123456789abcdefghij'],
  ['anthropic key', 'key sk-ant-abcdefgh1234 used'],
  ['openai-style key', 'sk-abcdefghijklmnopqrstuvwxyz'],
  ['short sk- is kept', 'sk-short'],
  ['stripe-style keys', 'sk_live_abcdefghij12 rk-test-0123456789 sk_test_short'],
  ['stripe key after an sk- key would match', 'sk-live-0123456789abcdefghij'],
  ['github tokens', 'ghp_abcdefghijklmnop1234 and github_pat_abcdefghijklmnopqrstuvwx'],
  ['aws key id', 'AKIAABCDEFGHIJKLMNOP'],
  ['aws key id after a non-ASCII letter (ASCII word boundary)', `${BS}u00e9AKIAABCDEFGHIJKLMNOP`],
  ['slack token', 'xoxb-1234567890-abcdef'],
  ['bearer, any case', 'Authorization: bearer abcdefghijklmnopqrstuvwxyz'],
  ['bearer after a no-break space (Unicode whitespace)', `Bearer${BS}u00a0abcdefghijklmnopqrstu`],
  ['key=value forms', 'password=hunter2&PASSWD=x token=abc Secret=s API-KEY=k apikey=q'],
  ['quoted value is not a match', 'token="abc"'],
  ['no word boundary', 'xapi_key=zz'],
  ['nothing to redact', 'connection refused'],
  // P9 security review SEC-RD1: the common credential shapes.
  ['PEM private key, multi-line', `before -----BEGIN RSA PRIVATE KEY-----${BS}nMIIEow${BS}nabc${BS}n-----END RSA PRIVATE KEY----- after`],
  ['PEM, two keys, lazy', `-----BEGIN PRIVATE KEY-----a-----END PRIVATE KEY----- mid -----BEGIN EC PRIVATE KEY-----b-----END EC PRIVATE KEY-----`],
  ['credentials in a URL', 'fetch failed: https://admin:hunter2@db.example.com/x and POSTGRES://u:p@h'],
  ['URL without credentials is kept', 'see https://example.com/a:b and mailto:x@y'],
  ['Slack webhook', 'posting to https://hooks.slack.com/services/T000/B000/XXXXxxxx_yy-z failed'],
  ['JWT', 'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF123_- rejected'],
  ['Google API key', 'using AIzaSyA1234567890abcdefghijklmnopqrstuv now; AIzaShort; AIzaSyA1234567890abcdefghijklmnopqrstu (34)'],
  ['HTTP Basic, any case', 'Authorization: Basic dXNlcjpwYXNz and basic   QWxhZGRpbjpvcGVu'],
  ['JSON secret fields', `{"password": "p@ss w0rd", "Client_Secret":"cs", "access-token" : "t", "user": "ada"}`],
  ['colon style', 'password: hunter2, TOKEN :abc;secret:s3 api-key:  k1'],
  ['colon after a non-ASCII letter (ASCII word boundary)', `${BS}u00e9token: x`],
  ['colon with Unicode whitespace', `token:${BS}u00a0abc`],
  ['order: URL before key=value', 'https://user:password=x@host/'],
  ['truncated at 200', 'x'.repeat(250)],
  ['exactly 200 is kept', 'y'.repeat(200)],
  ['truncation splits a surrogate pair as JS does', `${'a'.repeat(199)}${BS}uD83D${BS}uDE00b`],
  ['astral characters count two units', `${BS}uD83D${BS}uDE00`.repeat(101)],
  ['redaction happens before truncation', `${'z'.repeat(190)} password=${'p'.repeat(40)}`],
];

const red = redactCases.map(([name, input]) => {
  const value = JSON.parse(`"${input.replace(/"/g, `${BS}"`)}"`);
  return { name, input: JSON.stringify(value), output: redact(value) };
});
red.push({ name: 'null is empty', input: 'null', output: redact(null) });

writeFileSync(new URL('./parity.json', import.meta.url), `${JSON.stringify({
  version: 1,
  rule: 'pick: JS property access over JSON values; redact: kernel redact.mjs, default max 200',
  pick,
  redact: red,
}, null, 2)}\n`);
console.log(`wrote ${pick.length} pick and ${red.length} redact cases`);
