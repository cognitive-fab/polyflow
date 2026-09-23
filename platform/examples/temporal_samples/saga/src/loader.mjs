// The sample's sources are ts-node style: imports without extensions
// (`'./clients'`, `'../types/commands'`) and `import X = Namespace.X`
// declarations. Node 24 loads `.ts` as is only for erasable syntax and literal
// specifiers; this hook resolves a bare relative specifier to `.ts` or
// `/index.ts`, and transforms `.ts` sources with Node's own
// `stripTypeScriptTypes` in transform mode, so the sample's files load byte
// for byte, with no build step. Register it once:
//
//   node --import ./src/register.mjs src/worker.mjs
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.startsWith('file:')) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return nextResolve(pathToFileURL(candidate).href, context);
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    // TypeScript elides imports that are only used as types; Node's stripper
    // does not, so a file that exports only interfaces and types gets a
    // binding per erased export, and its importers link.
    const erased = [...source.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    const runtime = stripTypeScriptTypes(source, { mode: 'transform' });
    const shims = erased.map((name) => `export let ${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: shims ? `${runtime}\n${shims}\n` : runtime };
  }
  return nextLoad(url, context);
}
