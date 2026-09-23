// Run each test file in its own process with a hard timeout, and summarise.
// A Temporal test that hangs (a parked activity, a stuck workflow task) then
// costs one file's timeout instead of the whole suite.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('../test/', import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs') && (!only.length || only.some((o) => f.includes(o)))).sort();
let pass = 0, fail = 0;
const failures = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ['--no-warnings', '--test', '--test-concurrency=1', '--test-timeout=180000', join(dir, f)], { encoding: 'utf-8', timeout: 420_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const p = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0);
  const x = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 0);
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal;
  pass += p; fail += x + (timedOut ? 1 : 0);
  const bad = out.split('\n').filter((l) => /^✖ /.test(l) && !/failing tests/.test(l));
  console.log(`${timedOut ? 'TIMEOUT' : x ? 'FAIL   ' : 'ok     '} ${f.padEnd(34)} pass ${p} fail ${x}`);
  for (const b of [...new Set(bad)]) { console.log(`        ${b}`); failures.push(`${f}: ${b}`); }
}
console.log(`\ntotal: pass ${pass} fail ${fail}`);
process.exitCode = fail ? 1 : 0;
