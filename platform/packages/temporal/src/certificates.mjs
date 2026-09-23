// Certificates on disk: artefact digests, signing, and the worker-side check
// that refuses to run a machine whose files are not the ones admitted
// (FR-ADM.3; technical spec §7.2).

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { digestText, compareArtefacts, certificateMessage, certificateDigest } from '@cognitive-fab/polyflow-kernel';

export const CERTIFICATE_FILE = 'polyflow.certificate.json';

/** The files a machine directory's certificate covers, by artefact name. */
export function artefactFiles(dir) {
  const abs = resolve(dir);
  const d = JSON.parse(readFileSync(join(abs, 'polyflow.workflow.json'), 'utf-8'));
  const candidates = {
    descriptor: 'polyflow.workflow.json',
    contract: d.contract ?? 'contract.json',
    machine: d.machine ?? 'machine.cjs',
    effects: d.effects ?? 'effects.cjs',
    manifest: d.manifest ?? 'effects.manifest.json',
    effectInvariants: d.effectInvariants ?? 'effect-invariants.mjs',
    invariants: d.invariants ?? 'invariants.mjs',
    migrate: d.migrate ?? 'migrate.cjs',
    policy: d.policy ?? 'policy.json',
    observations: d.observations ?? 'observations.json',
  };
  const out = {};
  for (const [name, rel] of Object.entries(candidates)) {
    const f = join(abs, rel);
    if (existsSync(f)) out[name] = f;
  }
  // The local modules the machine and the mapper require, transitively: they
  // are bundled into the worker, so they are part of what is certified.
  const seen = new Set();
  const walk = (file) => {
    const src = readFileSync(file, 'utf-8');
    // Every require/import must name a literal: webpack bundles a template
    // literal like a string, and a computed path as a context over a whole
    // directory, which no certificate can name (P9 security SEC-CT1).
    for (const m of src.matchAll(/\b(require|import)\s*\(\s*([^)]*?)\s*\)/g)) {
      const arg = m[2];
      if (!/^(['"])[^'"`$]*\1$/.test(arg) && !/^`[^`$]*`$/.test(arg)) {
        throw new Error(`${relative(abs, file)}: ${m[1]}(${arg.slice(0, 60)}) does not name a literal path: a certificate cannot cover code chosen at run time`);
      }
    }
    for (const m of src.matchAll(/require\(\s*['"`](\.{1,2}\/[^'"`]+)['"`]\s*\)/g)) {
      let dep = resolve(dirname(file), m[1]);
      if (!existsSync(dep) && existsSync(`${dep}.cjs`)) dep = `${dep}.cjs`;
      if (!existsSync(dep) && existsSync(`${dep}.js`)) dep = `${dep}.js`;
      if (seen.has(dep) || !existsSync(dep)) continue;
      seen.add(dep);
      out[`module:${relative(abs, dep).split('\\').join('/')}`] = dep;
      if (/\.(c)?js$/.test(dep)) walk(dep);
    }
  };
  for (const k of ['machine', 'effects']) if (out[k]) walk(out[k]);
  return out;
}

/** The sam-pattern version a machine directory resolves. */
export function samPatternVersion(dir) {
  try {
    const req = createRequire(pathToFileURL(join(resolve(dir), 'x.cjs')).href);
    return JSON.parse(readFileSync(req.resolve('@cognitive-fab/sam-pattern/package.json'), 'utf-8')).version;
  } catch { return null; }
}

/** Digest every artefact present, LF-normalised (a CRLF checkout hashes the same). */
export function artefactDigests(dir) {
  return Object.fromEntries(Object.entries(artefactFiles(dir)).map(([name, f]) => [name, digestText(readFileSync(f, 'utf-8'))]));
}

/** Add a signature. `key` = { keyId, privateKeyPem }. */
export function signCertificate(cert, key) {
  const sig = sign(null, Buffer.from(certificateMessage(cert)), createPrivateKey(key.privateKeyPem)).toString('base64');
  return { ...cert, signatures: [...(cert.signatures ?? []).filter((s) => s.keyId !== key.keyId), { keyId: key.keyId, alg: 'ed25519', sig }] };
}

/** At least one signature from a trusted key, over this exact digest. */
export function verifyCertificate(cert, trust = {}) {
  // The signature covers the digest; the digest must cover THIS body (P6-P8 review SV5).
  if (certificateDigest(cert) !== cert.digest) return { ok: false, reason: 'the certificate body does not match its digest: it was edited after it was sealed' };
  for (const s of cert.signatures ?? []) {
    const pem = trust[s.keyId];
    if (pem && verify(null, Buffer.from(certificateMessage(cert)), createPublicKey(pem), Buffer.from(s.sig, 'base64'))) {
      return { ok: true, keyId: s.keyId };
    }
  }
  return { ok: false, reason: (cert.signatures ?? []).length ? 'no signature from a trusted key verifies' : 'the certificate is unsigned' };
}

/**
 * The worker-side gate. Throws, naming the file, unless the directory holds a
 * certificate that is signed by a trusted key and describes exactly the files
 * present. Returns the certificate.
 */
export function checkMachineDir(dir, trust) {
  const certPath = join(resolve(dir), CERTIFICATE_FILE);
  if (!existsSync(certPath)) throw new Error(`${dir}: no ${CERTIFICATE_FILE} — run \`polyflow admit\` first; an unadmitted machine does not run`);
  const cert = JSON.parse(readFileSync(certPath, 'utf-8'));
  const files = artefactFiles(dir);
  const problems = compareArtefacts(cert, artefactDigests(dir));
  if (problems.length) {
    throw new Error(`${dir}: the files are not the ones admitted:\n${problems.map((p) => `  - ${p.name}${files[p.name] ? ` (${files[p.name]})` : ''}: ${p.problem}${p.want ? `\n      certified ${p.want}` : ''}${p.have ? `\n      found     ${p.have}` : ''}`).join('\n')}`);
  }
  const sig = verifyCertificate(cert, trust);
  if (!sig.ok) throw new Error(`${dir}: certificate ${cert.buildId}: ${sig.reason}`);
  // The SAM library is part of the machine's semantics: a different version is a different machine.
  const sam = samPatternVersion(dir);
  if (cert.toolchain?.['sam-pattern'] && sam !== cert.toolchain['sam-pattern']) {
    throw new Error(`${dir}: certified with @cognitive-fab/sam-pattern ${cert.toolchain['sam-pattern']}, but ${sam ?? 'none'} is installed`);
  }
  return cert;
}
