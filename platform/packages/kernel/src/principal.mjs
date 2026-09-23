// Verified principals — plan P5.5; technical spec §5.7.
//
// Until now, "who approved" and "who reported" were whatever the caller wrote
// in the payload, recorded `verified: false`. A verified principal is a
// SIGNED statement of who someone is: an identity provider, the gateway or the
// approvals console signs `{ id, roles, aud, exp }` with an ed25519 key, and
// the worker's operator lists the keys it trusts. The workflow checks the
// signature itself (pure JS, see ./ed25519.mjs), in the Update validator, so a
// forged or expired identity is refused before it enters history, and a replay
// reaches the same verdict.
//
// A token is bound to ONE action (P9 security review SEC-PR1): its `act`
// names the operation, the workflow and run, the approval or order, and for an
// approval the decision and the arguments digest. Temporal keeps Update
// arguments in history, so a token lifted from there authorises exactly the
// action it already recorded, and nothing else. `aud` binds it to a
// namespace; `iat`/`exp` bound its life (SEC-PR3); and it is refused by SIZE
// before anything is hashed, because verification runs in an Update validator
// inside the workflow task's deadline (SEC-PR2).

import { canonical } from './canonical.mjs';
import { verifyEd25519 } from './ed25519.mjs';

/** The exact bytes a principal token's signature covers. */
export const principalMessage = (body) => `polyflow-principal\n${canonical(body)}`;

export const PRINCIPAL_LIMITS = Object.freeze({ maxBodyChars: 2048, maxTtlMs: 15 * 60_000 });
const FIELDS = new Set(['keyId', 'id', 'roles', 'aud', 'iat', 'exp', 'act']);

/** Does the token's `act` cover the expected action? Every expected field must match exactly. */
function covers(act, expected) {
  if (!expected) return true;
  if (!act || typeof act !== 'object') return false;
  return Object.entries(expected).every(([k, v]) => v === undefined || act[k] === v);
}

/**
 * The identity a token CLAIMS, without checking it. For an Update handler only:
 * its validator verified the token when the Update was accepted, and the
 * handler runs again on every replay, when the trust store may have changed
 * (a rotated key). Verifying there would fail replay (P9 review RT1).
 */
export function principalClaims(presented) {
  const b = presented?.body ?? {};
  return { id: String(b.id ?? 'unknown'), roles: Array.isArray(b.roles) ? b.roles.filter((r) => typeof r === 'string') : [], verified: true, keyId: b.keyId ?? null };
}

/**
 * @param {{ body: { keyId, id, roles?, aud?, exp }, sig: string }} presented
 * @param {object} o
 * @param {Record<string,string>} o.trust  keyId -> ed25519 public key (SPKI PEM or raw base64)
 * @param {number} o.now                   workflow time, ms
 * @param {string} [o.audience]            the namespace this worker serves
 * @returns {{ ok: true, principal: { id, roles, verified: true, keyId } } | { ok: false, reason: string }}
 */
export function verifyPrincipal(presented, { trust, now, audience = null, action = null, maxTtlMs = PRINCIPAL_LIMITS.maxTtlMs }) {
  const body = presented?.body;
  if (!body || typeof body !== 'object' || typeof presented.sig !== 'string') return { ok: false, reason: 'a verified principal is a signed token { body, sig }; this is a bare claim' };
  // Refused by shape and size first: nothing below is hashed for a token that fails here.
  if (presented.sig.length > 128) return { ok: false, reason: 'the token signature is not an ed25519 signature' };
  const unknown = Object.keys(body).filter((k) => !FIELDS.has(k));
  if (unknown.length) return { ok: false, reason: `the token carries unknown fields: ${unknown.slice(0, 3).join(', ')}` };
  let size;
  try { size = canonical(body).length; } catch { return { ok: false, reason: 'the token body is not canonical JSON' }; }
  if (size > PRINCIPAL_LIMITS.maxBodyChars) return { ok: false, reason: `the token body is ${size} characters; at most ${PRINCIPAL_LIMITS.maxBodyChars}` };
  if (!Number.isFinite(body.iat) || body.iat > now + 60_000) return { ok: false, reason: 'the token has no issue time, or one in the future' };
  if (Number.isFinite(body.exp) && body.exp - body.iat > maxTtlMs) return { ok: false, reason: `the token lives ${body.exp - body.iat} ms; at most ${maxTtlMs}` };
  if (!covers(body.act, action)) return { ok: false, reason: `the token was signed for another action (${JSON.stringify(body.act ?? null).slice(0, 120)})` };
  if (typeof body.id !== 'string' || !body.id) return { ok: false, reason: 'the token names no principal id' };
  const key = trust?.[body.keyId];
  if (!key) return { ok: false, reason: `the token is signed by '${body.keyId}', which this worker does not trust` };
  if (!Number.isFinite(body.exp) || body.exp <= now) return { ok: false, reason: 'the token has expired' };
  if (audience && body.aud !== audience) return { ok: false, reason: `the token is for '${body.aud ?? 'no audience'}', not '${audience}'` };
  let valid;
  try { valid = verifyEd25519(principalMessage(body), presented.sig, key); } catch { valid = false; }
  if (!valid) return { ok: false, reason: 'the token signature does not verify' };
  const roles = Array.isArray(body.roles) ? body.roles.filter((r) => typeof r === 'string') : [];
  return { ok: true, principal: { id: body.id, roles, verified: true, keyId: body.keyId } };
}
