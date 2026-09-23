// Minting verified principals — plan P5.5. Runs OUTSIDE the workflow: in the
// identity bridge, the approvals console, or the gateway, wherever a person or
// an agent has already been authenticated. The workflow only verifies
// (kernel `verifyPrincipal`, pure JS, in the isolate).
import { createPrivateKey, sign } from 'node:crypto';
import { principalMessage } from '@cognitive-fab/polyflow-kernel';

/**
 * Sign who someone is, for ONE action, for a short while (P9 security SEC-PR1).
 * `act` names the action exactly as the workflow will check it:
 *   approve  { op: 'approve', wf, run, ref: approvalId, decision, argsDigest }
 *   report   { op: 'report', wf, ref: orderId, attempt, digest: digest({ ok, result, error, permanent }) }
 *   claim    { op: 'claim', wf, ref: orderId }
 *   propose  { op: 'propose', wf, ref: action, digest: digest(data) }   (Update only)
 *   release  { op: 'release', wf, run, to: digest(snapshot) }
 *   migrate  { op: 'migrate', wf, run, ref: fromDigest, to: digest(snapshot) }
 *   version  { op: 'version', wf }
 * @param {{ id: string, roles?: string[], aud?: string, act?: object }} who   aud: the namespace it acts in
 * @param {{ keyId: string, privateKeyPem: string }} key
 * @param {{ ttlMs?: number, now?: number }} [o]
 * @returns {{ body: object, sig: string }}  pass this as `actor` / `principal`
 */
export function signPrincipal(who, key, { ttlMs = 5 * 60_000, now = Date.now() } = {}) {
  const body = { keyId: key.keyId, id: who.id, roles: [...(who.roles ?? [])].sort(), ...(who.aud ? { aud: who.aud } : {}), ...(who.act ? { act: who.act } : {}), iat: now, exp: now + ttlMs };
  const sig = sign(null, Buffer.from(principalMessage(body)), createPrivateKey(key.privateKeyPem)).toString('base64');
  return { body, sig };
}
