// The admission certificate — FR-ADM.1, .6; technical spec §3.5.
//
// A certificate says: these exact artefacts (by digest) were checked, by these
// checks, over this declared domain, with this result, and here is who says
// so. Its digest IS the version: the build id a Temporal Worker Deployment
// uses is derived from it, so there is no second version number to drift.
//
// Pure: building and digesting happen here; signing needs a key and lives in
// the Temporal package (node:crypto).

import { digest } from './digest.mjs';

export const ARTEFACTS = Object.freeze(['descriptor', 'contract', 'machine', 'effects', 'manifest', 'effectInvariants', 'invariants', 'migrate', 'policy', 'observations']);

/** The message a certificate signature covers. Fixed format, any language. */
export const certificateMessage = (cert) => `polyflow-certificate\n${cert.digest}`;

/** Everything but `digest` and `signatures`, digested. */
export function certificateDigest(cert) {
  const { digest: _d, signatures: _s, ...body } = cert;
  return digest(body);
}

/**
 * Assemble a certificate body. `artefacts` maps artefact name -> digest (only
 * those present). `checks` is the list of checks run, each with its own result.
 */
export function buildCertificate({ machine, artefacts, guarantees, checks, domains, boundAccepted = null, toolchain, issuedAt }) {
  // `module:<path>` artefacts are the local modules the machine requires: the
  // certificate covers the code that runs, not only the files it names (P4/P5 review DEP).
  for (const k of Object.keys(artefacts)) if (!ARTEFACTS.includes(k) && !k.startsWith('module:')) throw new Error(`unknown artefact '${k}'`);
  const failed = checks.filter((c) => c.ok === false);
  const bounded = checks.some((c) => c.bounded);
  if (failed.length) throw new Error(`cannot certify '${machine}': ${failed.map((c) => c.name).join(', ')} failed`);
  if (bounded && !boundAccepted) throw new Error(`cannot certify '${machine}': exploration was bounded and the bound was not accepted`);
  const body = {
    v: 1,
    subject: { workflowType: 'GovernedWorkflow', machine },
    artefacts,
    guarantees: [...guarantees],
    checks,
    domains,
    boundAccepted,
    toolchain,
    issuedAt,
  };
  // The build id is a function of WHAT was certified, not WHEN: admitting the
  // same files with the same toolchain gives the same build (P4/P5 review, minor).
  const d = digest({ subject: body.subject, artefacts, guarantees: body.guarantees, domains, toolchain, boundAccepted });
  return { ...body, buildId: `cert-${d.slice(7, 19)}`, signatures: [] };
}

/** Finalise: compute the digest over the body including buildId. */
export function sealCertificate(cert) {
  const sealed = { ...cert };
  delete sealed.digest;
  sealed.signatures = sealed.signatures ?? [];
  sealed.digest = certificateDigest(sealed);
  return sealed;
}

/**
 * Compare a certificate against the artefact digests actually present. Returns
 * the list of mismatches (empty = the certificate describes these files).
 */
export function compareArtefacts(cert, actual) {
  const problems = [];
  for (const name of new Set([...Object.keys(cert.artefacts ?? {}), ...Object.keys(actual)])) {
    const want = cert.artefacts?.[name];
    const have = actual[name];
    if (want && !have) problems.push({ name, problem: 'certified but missing', want });
    else if (!want && have) problems.push({ name, problem: 'present but not certified', have });
    else if (want !== have) problems.push({ name, problem: 'changed since certification', want, have });
  }
  if (certificateDigest(cert) !== cert.digest) problems.push({ name: 'certificate', problem: 'the certificate itself was edited after sealing' });
  return problems;
}
