// Resolve the polyrun engine. polyflow embeds it in-process rather than
// talking to a daemon over HTTP: same trust boundary, one less moving part.
// POLYFLOW_POLYRUN overrides the checkout location (default: sibling repo).
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const has = (dir) => dir && existsSync(resolve(dir, 'polyrun', 'src', 'index.mjs'));

// Installed dependency first, sibling checkout second, explicit override always
// wins — so a packaged install and a working tree both just run.
const candidates = [
  process.env.POLYFLOW_POLYRUN && resolve(process.env.POLYFLOW_POLYRUN),
  resolve(here, '..', 'node_modules', 'polygraph'),
  resolve(here, '..', '..', 'polygraph'),
];
const root = candidates.find(has);

if (!root) {
  throw new Error(
    'polyrun not found. Run `npm install`, or set POLYFLOW_POLYRUN to a polygraph checkout. ' +
    `Looked in: ${candidates.filter(Boolean).join(', ')}`
  );
}

const load = (rel) => import(pathToFileURL(resolve(root, rel)).href);

export const POLYGRAPH_ROOT = root;
export const { createRuntime, createStore } = await load('polyrun/src/index.mjs');
export const { checkEffects, renderReport } = await load('polyrun/src/check-effects.mjs');
