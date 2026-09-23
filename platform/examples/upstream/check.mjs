#!/usr/bin/env node
// Checks every port of an official Temporal sample against the pinned upstream
// copy beside it. A port declares, in its `upstream.json`:
//
//   { "source": "samples-typescript@8907f29",       // a directory here
//     "root": "expense",                            // the sample's directory under it ("." for the repository root)
//     "files": { "<path under the port>": { "identical": true }
//              | { "identical": false, "why": "...", "upstream": "<path under root, when it differs>" } },
//     "notPorted": ["<path under root>", ...] }     // upstream files the port derives nothing from
//
// The headline claim of a port is which files did NOT change, so it is made
// mechanical: an `identical: true` file must match upstream byte for byte
// (line endings normalised, since git may check them out differently), and an
// `identical: false` file must actually differ, so the manifest cannot drift.
//
//   node platform/examples/upstream/check.mjs            # all ports
//   node platform/examples/upstream/check.mjs <dir>...   # these ports

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const platform = resolve(here, '..', '..');

function* manifests(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.venv' || name === 'upstream' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* manifests(p);
    else if (name === 'upstream.json') yield p;
  }
}

const norm = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');

let failures = 0;
const ports = process.argv.length > 2 ? process.argv.slice(2).map((d) => join(resolve(d), 'upstream.json')) : [...manifests(platform)];
for (const manifest of ports) {
  const port = dirname(manifest);
  const m = JSON.parse(readFileSync(manifest, 'utf8'));
  const upstream = join(here, m.source, m.root);
  console.log(`${m.source}${m.root === '.' ? '' : `/${m.root}`} -> ${port.slice(platform.length + 1).replace(/\\/g, '/')}`);
  for (const [file, spec] of Object.entries(m.files)) {
    let ours, theirs;
    try { ours = norm(readFileSync(join(port, file))); } catch { console.log(`  MISSING  ${file} (port)`); failures++; continue; }
    try { theirs = norm(readFileSync(join(upstream, spec.upstream ?? file))); } catch { console.log(`  MISSING  ${file} (upstream)`); failures++; continue; }
    const same = ours === theirs;
    if (spec.identical && !same) { console.log(`  CHANGED  ${file} — declared identical`); failures++; }
    else if (!spec.identical && same) { console.log(`  SAME     ${file} — declared changed (${spec.why})`); failures++; }
    else console.log(`  ${same ? 'identical' : 'changed  '}  ${file}${same ? '' : ` — ${spec.why}`}`);
  }
  // Upstream files the port does not derive anything from (its own package.json
  // and README are written from scratch): named so the scope of the claim is
  // visible, and checked to exist in the pinned copy.
  for (const file of m.notPorted ?? []) {
    if (!existsSync(join(upstream, file))) { console.log(`  MISSING  ${file} (upstream, declared not ported)`); failures++; }
    else console.log(`  not ported ${file}`);
  }
}
if (failures) { console.log(`\n${failures} manifest mismatch(es)`); process.exit(1); }
