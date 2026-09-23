// `polyflow admit` — FR-ADM.1–.5; technical spec §7.1.
//
// Nothing runs on the strength of "it worked once". Admission runs every
// check the machine's artefacts support and, only if all of them pass,
// writes a certificate naming the exact files it checked:
//
//   check-effects   polygraph: what machine ∘ mapper may EMIT, on every path
//                   over the declared domain, against the effect invariants
//   structural      every state can finish; waits on people arm timers; a
//                   stop exists (when declared); no poisoned step
//   policy          when the directory carries policy.json: the policy is
//                   admitted, every emitted kind is classified, and every
//                   irreversible kind is guarded
//   domain          the machine explores the contract's WHOLE data domain:
//                   the certificate names that domain, so every combination
//                   it declares must be one the check stepped (P6-P8 review CD)
//   observations    every battery parses (bands, calibration, model, source),
//                   and every fact the manifest maps from a judge is one a
//                   battery produces (review JV4)
//
// A bounded exploration is not a pass unless the owner accepts the bound, and
// the acceptance is written into the certificate.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  createHost, structuralChecks, admitPolicy, buildCertificate, sealCertificate, digest, canonical, parseBattery,
} from '@cognitive-fab/polyflow-kernel';
import { artefactDigests, artefactFiles, signCertificate, CERTIFICATE_FILE } from '@cognitive-fab/polyflow-temporal';

const require = createRequire(import.meta.url);
const polygraphRoot = resolve(require.resolve('@cognitive-fab/polygraph/package.json'), '..');
const polygraphVersion = JSON.parse(readFileSync(join(polygraphRoot, 'package.json'), 'utf-8')).version;
const kernelVersion = JSON.parse(readFileSync(require.resolve('@cognitive-fab/polyflow-kernel/package.json'), 'utf-8')).version;

const { domainFromManifest } = require(join(polygraphRoot, 'scripts', 'sam-adapter.cjs'));

/** Every combination a contract's dataDomain declares for one action. */
function combinations(fields) {
  let out = [{}];
  for (const [field, values] of Object.entries(fields ?? {})) {
    if (!Array.isArray(values)) continue;
    out = out.flatMap((c) => values.map((v) => ({ ...c, [field]: v })));
  }
  return out;
}

/**
 * The contract's domain that the machine module does NOT explore. check-effects
 * steps the module's own `domain` arrays; the certificate names the contract's
 * dataDomain. They must agree, or the certificate claims a domain nobody explored.
 */
export function domainGaps(mod, contract) {
  const { steps } = domainFromManifest(mod);
  const explored = new Set(steps.map((s) => `${s.action}|${canonical(s.data ?? {})}`));
  const gaps = [];
  for (const [action, fields] of Object.entries(contract.dataDomain ?? {})) {
    for (const c of combinations(fields)) {
      if (!explored.has(`${action}|${canonical(c)}`)) gaps.push({ action, data: c });
    }
  }
  return gaps;
}

/** Problems with the observation batteries, and with the facts the manifest reads from them. */
function observationProblems(files, manifest, descriptor) {
  const problems = [];
  if (!files.observations) return problems;
  let raw;
  try { raw = JSON.parse(readFileSync(files.observations, 'utf-8')); } catch (err) { return [`observations.json: ${err.message}`]; }
  const facts = new Set();
  for (const [name, b] of Object.entries(raw.batteries ?? {})) {
    try {
      // Illustrative samples are allowed through parsing (they are inert at run
      // time unless a development worker opts in); everything else must hold.
      const battery = parseBattery({ name, ...b }, { allowIllustrative: true });
      if (!battery.model) problems.push(`battery '${name}': name the Jev model it was calibrated on (model), or a vendor change re-bands every question silently`);
      if (!Array.isArray(battery.source) || battery.source.length === 0) problems.push(`battery '${name}': declare the state fields it may send (source); nothing else leaves the machine`);
      for (const q of Object.values(battery.questions)) facts.add(q.fact.slice(4));
    } catch (err) {
      problems.push(`battery '${name}': ${err.message}`);
    }
  }
  if (Object.keys(raw.batteries ?? {}).length === 0) problems.push('observations.json declares no battery');
  // A manifest that maps result.facts.<name> must read a fact some battery produces.
  for (const [kind, decl] of Object.entries(manifest.effects ?? {})) {
    for (const hook of ['onSuccess', 'onFailure', 'onExhausted']) {
      for (const path of Object.values(decl?.[hook]?.map ?? {})) {
        const m = /^(?:\$\.)?result\.facts\.([a-z0-9_]+)$/.exec(String(path));
        if (m && !facts.has(m[1])) problems.push(`effect '${kind}' ${hook} reads result.facts.${m[1]}, which no battery produces`);
      }
    }
  }
  const observes = Object.values(descriptor.tools ?? {}).some((t) => t?.activity === 'polyflow.observe');
  if (observes && facts.size === 0) problems.push('the descriptor orders polyflow.observe, but no battery is declared');
  return problems;
}

async function loadCheckEffects() {
  return (await import(pathToFileURL(join(polygraphRoot, 'polyrun', 'src', 'check-effects.mjs')).href)).checkEffects;
}

/**
 * Admit a machine directory.
 * @returns {Promise<{ ok, certificate?, checks, problems }>}
 */
export async function admit(dir, { key = null, acceptBound = null, maxDepth = 12, maxPaths = 50_000, maxStates = 20_000, now = new Date() } = {}) {
  const abs = resolve(dir);
  const files = artefactFiles(abs);
  const problems = [];
  const checks = [];
  for (const need of ['descriptor', 'contract', 'machine', 'effects', 'manifest', 'effectInvariants']) {
    if (!files[need]) problems.push(`missing ${need}`);
  }
  if (problems.length) return { ok: false, checks, problems };

  const descriptor = JSON.parse(readFileSync(files.descriptor, 'utf-8'));
  const contract = JSON.parse(readFileSync(files.contract, 'utf-8'));
  const manifest = JSON.parse(readFileSync(files.manifest, 'utf-8'));
  // A fresh require per admission: a machine module holds its model in module scope.
  const req = createRequire(pathToFileURL(join(abs, 'x.cjs')).href);
  delete req.cache[req.resolve(files.machine)];
  delete req.cache[req.resolve(files.effects)];
  const machineModule = req(files.machine);
  const host = createHost({ module: machineModule, contract, mapper: req(files.effects).effects, manifest });

  // 0. the domain the certificate will name is the domain the check explores
  const gaps = domainGaps(machineModule, contract);
  checks.push({ name: 'domain', ok: gaps.length === 0, missing: gaps.length });
  if (gaps.length) {
    problems.push(`the machine's action domains do not cover the contract's dataDomain: ${gaps.length} combination(s) were never explored, e.g. ${gaps.slice(0, 3).map((g) => `${g.action} ${JSON.stringify(g.data)}`).join('; ')}. Add them to the machine's \`domain\` arrays`);
  }

  // 0b. observation batteries (Jev)
  const obs = observationProblems(files, manifest, descriptor);
  if (files.observations) checks.push({ name: 'observations', ok: obs.length === 0 });
  problems.push(...obs);

  // 1. check-effects (polygraph)
  const checkEffects = await loadCheckEffects();
  const ce = await checkEffects({
    module: files.machine, mapper: files.effects, manifest: files.manifest,
    invariants: files.effectInvariants, contract: files.contract, maxDepth, maxPaths,
  });
  const invMod = await import(`${pathToFileURL(files.effectInvariants).href}?t=${Date.now()}`);
  const guarantees = (invMod.effectInvariants ?? []).map((i) => i.name);
  const violations = ce.violations ?? [];
  checks.push({
    // ok is about violations only; a bound stands on its own (review AB).
    name: 'check-effects', ok: violations.length === 0, bounded: Boolean(ce.bounded),
    pathsExplored: ce.pathsExplored, statesSeen: ce.statesSeen, violations: violations.length,
  });
  for (const v of violations) problems.push(`effect invariant '${v.invariant ?? v.name}' is violated: ${JSON.stringify(v.path ?? v.witness ?? v).slice(0, 400)}`);

  // 2. structural, state invariants included
  const stateInvariants = files.invariants
    ? ((await import(`${pathToFileURL(files.invariants).href}?t=${Date.now()}`)).stateInvariants ?? [])
    : [];
  const st = structuralChecks({ host, contract, descriptor, maxStates, stateInvariants });
  const failed = st.items.filter((i) => i.ok === false);
  guarantees.push(...stateInvariants.map((i) => i.name));
  checks.push({
    name: 'structural', ok: failed.length === 0, bounded: st.bounded, statesSeen: st.statesSeen,
    // Declared exceptions (unstoppable states) are part of what was certified.
    items: st.items.map(({ name, ok, detail }) => ({ name, ok, ...(detail?.exceptions && Object.keys(detail.exceptions).length ? { exceptions: detail.exceptions } : {}) })),
  });
  for (const f of failed) problems.push(`structural check '${f.name}' failed: ${JSON.stringify(f.detail).slice(0, 400)}`);

  // 3. policy
  if (files.policy) {
    try {
      const policy = admitPolicy(JSON.parse(readFileSync(files.policy, 'utf-8')));
      const kinds = Object.keys(manifest.effects ?? {});
      const unclassified = kinds.filter((k) => !policy.effects[k]);
      const irreversible = policy.notes;
      checks.push({ name: 'policy', ok: unclassified.length === 0 && irreversible.length === 0, policy: policy.digest, unclassified, notes: irreversible });
      for (const k of unclassified) problems.push(`effect kind '${k}' has no class in policy.json`);
      for (const n of irreversible) problems.push(n);
    } catch (err) {
      checks.push({ name: 'policy', ok: false });
      problems.push(err.message);
    }
  }

  // 4. the code that runs: only certified local modules, no other packages
  for (const p of moduleProblems(abs, files)) problems.push(p);

  const bounded = checks.some((c) => c.bounded);
  if (bounded && !acceptBound) problems.push('exploration was bounded; pass --accept-bound "<why>" to accept it, and the acceptance is recorded');
  if (problems.length) return { ok: false, checks, problems, guarantees };

  let cert = buildCertificate({
    machine: descriptor.name,
    artefacts: artefactDigests(abs),
    guarantees,
    checks,
    domains: digest(contract.dataDomain ?? {}),
    boundAccepted: bounded ? acceptBound : null,
    // (the principal who accepted it is recorded when principals exist: plan P5.5)
    toolchain: { polygraph: polygraphVersion, kernel: kernelVersion, 'sam-pattern': samVersion(abs) },
    issuedAt: now.toISOString(),
  });
  cert = sealCertificate(cert);
  if (key) cert = signCertificate(cert, key);
  writeFileSync(join(abs, CERTIFICATE_FILE), `${JSON.stringify(cert, null, 2)}\n`);
  return { ok: true, certificate: cert, checks, problems: [], guarantees };
}

/** The installed sam-pattern version the machine resolves: part of what was certified. */
function samVersion(dir) {
  try {
    const req = createRequire(pathToFileURL(join(dir, 'x.cjs')).href);
    return JSON.parse(readFileSync(req.resolve('@cognitive-fab/sam-pattern/package.json'), 'utf-8')).version;
  } catch { return null; }
}

/** A machine or mapper may require only sam-pattern and certified local modules. */
function moduleProblems(dir, files) {
  const out = [];
  for (const [name, f] of Object.entries(files)) {
    if (!/\.(c|m)?js$/.test(f) || name === 'effectInvariants' || name === 'invariants') continue;
    const src = readFileSync(f, 'utf-8');
    // Every spelling webpack bundles: quotes or a template literal, spaces
    // before the parenthesis, require() or import() or an ESM import (P9 review DEP).
    const ids = [
      ...[...src.matchAll(/\b(?:require|import)\s*\(\s*(['"`])([^'"`$]+)\1\s*\)/g)].map((m) => m[2]),
      ...[...src.matchAll(/\bimport\s+(?:[^'"`;]*?\sfrom\s+)?(['"])([^'"]+)\1/g)].map((m) => m[2]),
    ];
    for (const id of ids) {
      if (id === '@cognitive-fab/sam-pattern' || id.startsWith('./') || id.startsWith('../')) continue;
      out.push(`${name} requires '${id}': a machine may require only @cognitive-fab/sam-pattern and its own certified modules`);
    }
  }
  return out;
}

export const certificatePath = (dir) => join(resolve(dir), CERTIFICATE_FILE);
export const hasCertificate = (dir) => existsSync(certificatePath(dir));
