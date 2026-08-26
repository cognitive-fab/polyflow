// Resolve the polyrun engine. polyflow embeds it in-process rather than
// talking to a daemon over HTTP: same trust boundary, one less moving part.
// POLYFLOW_POLYRUN overrides the checkout location (default: sibling repo).
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const has = (dir) => dir && existsSync(resolve(dir, 'polyrun', 'src', 'index.mjs'));

// An explicit override is used or it fails. Falling back from a bad
// POLYFLOW_POLYRUN would run a different engine than the one the caller asked
// to test, and say nothing about it.
const override = process.env.POLYFLOW_POLYRUN && resolve(process.env.POLYFLOW_POLYRUN);
if (override && !has(override)) {
  throw new Error(
    `POLYFLOW_POLYRUN is set to '${process.env.POLYFLOW_POLYRUN}' but there is no ` +
    `polyrun/src/index.mjs under ${override}. Point it at a polygraph checkout or unset it.`
  );
}

// Otherwise: installed dependency first, sibling checkout second.
const candidates = [
  override,
  resolve(here, '..', 'node_modules', 'polygraph'),
  resolve(here, '..', '..', 'polygraph'),
].filter(Boolean);
const root = candidates.find(has);

if (!root) {
  throw new Error(
    'polyrun not found. Run `npm install`, or set POLYFLOW_POLYRUN to a polygraph checkout. ' +
    `Looked in: ${candidates.join(', ')}`
  );
}

const load = (rel) => import(pathToFileURL(resolve(root, rel)).href);

export const POLYGRAPH_ROOT = root;
export const { createRuntime, createStore } = await load('polyrun/src/index.mjs');
export const { checkEffects, renderReport } = await load('polyrun/src/check-effects.mjs');
