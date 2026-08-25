// Resolve the polyrun engine. polyflow embeds it in-process rather than
// talking to a daemon over HTTP: same trust boundary, one less moving part.
// POLYFLOW_POLYRUN overrides the checkout location (default: sibling repo).
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.POLYFLOW_POLYRUN
  ? resolve(process.env.POLYFLOW_POLYRUN)
  : resolve(here, '..', '..', 'polygraph');

if (!existsSync(resolve(root, 'polyrun', 'src', 'index.mjs'))) {
  throw new Error(
    `polyrun not found at ${root}. Set POLYFLOW_POLYRUN to the polygraph checkout.`
  );
}

const load = (rel) => import(pathToFileURL(resolve(root, rel)).href);

export const POLYGRAPH_ROOT = root;
export const { createRuntime, createStore } = await load('polyrun/src/index.mjs');
export const { checkEffects, renderReport } = await load('polyrun/src/check-effects.mjs');
