// Secret redaction before anything is recorded — FR-LED.5. The same patterns
// as polyflow's decision journal (src/decisions.mjs): redact first, then truncate.
// Order matters: the multi-line and URL shapes run first, so a later
// key=value rule never splits them. Best effort by design: the real control is
// that argument and result BODIES are never recorded, only their digests.
// Mirrored byte for byte in python/polyflow_temporal/redact.py (conformance/parity.json).
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@/gi,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/_-]+/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bBasic\s+[A-Za-z0-9+\/=]{8,}/gi,
  /"(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret)"\s*:\s*"[^"]*"/gi,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*:\s*[^\s,;"']+/gi,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, /\bsk-[A-Za-z0-9]{20,}/g, /\b[sr]k[-_](?:live|test)[-_][A-Za-z0-9]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:password|passwd|secret|token|api[_-]?key)=[^\s&"']+/gi,
];

/** Card numbers (PANs): 13–19 digits, spaces or dashes allowed, that pass the Luhn check. */
const PAN = /\b\d(?:[ -]?\d){12,18}\b/g;
const luhn = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

/** Redaction for text that LEAVES the machine (a judge's input): secrets and card numbers, no truncation. */
export function redactOutbound(text) {
  let s = String(text ?? '');
  for (const re of SECRETS) s = s.replace(re, '[redacted]');
  return s.replace(PAN, (m) => (luhn(m.replace(/[ -]/g, '')) ? '[card]' : m));
}

export function redact(text, max = 200) {
  let s = String(text ?? '');
  for (const re of SECRETS) s = s.replace(re, '[redacted]');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
