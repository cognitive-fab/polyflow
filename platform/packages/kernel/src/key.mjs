// Derived run identity — FR-GOV.5. The same rule as polyflow's library.mjs,
// kept pure here so the Temporal client and the gateway share it.
//
// A workflow may DERIVE its run key from typed input fields instead of letting
// the caller name it. That is the difference between "this is the 2026-08-25
// run" and "this is whatever the agent decided to call it": an agent that finds
// a completed run will otherwise invent a fresh key and do the job twice
// (polyflow FINDINGS-phase3.md §6).

export function parseKeyPolicy(raw) {
  if (!raw || !raw.template) return null;
  const template = String(raw.template);
  const names = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error(`key.template '${template}' names no fields`);
  const declared = raw.fields ?? {};
  return {
    template,
    fields: names.map((name) => ({
      name,
      pattern: declared[name]?.pattern ?? null,
      description: declared[name]?.description ?? '',
    })),
  };
}

export class KeyError extends Error {
  constructor(message) { super(message); this.name = 'KeyError'; this.expected = true; }
}

/** Resolve a run key from the caller's input, or explain precisely why not. */
export function deriveKey(policy, input = {}) {
  const problems = [];
  const values = {};
  for (const field of policy.fields) {
    const raw = input?.[field.name];
    if (raw === undefined || raw === null || raw === '') {
      problems.push(`input.${field.name} is required${field.description ? ` (${field.description})` : ''}`);
      continue;
    }
    const value = String(raw);
    // Agent input against an operator's pattern: bounded, so a pathological
    // pattern cannot be driven into catastrophic backtracking (P9 security SEC-KD1).
    if (value.length > 512) {
      problems.push(`input.${field.name} is ${value.length} characters; a key field is at most 512`);
      continue;
    }
    if (field.pattern && !new RegExp(field.pattern).test(value)) {
      problems.push(`input.${field.name} = ${JSON.stringify(value)} does not match ${field.pattern}${field.description ? ` (${field.description})` : ''}`);
      continue;
    }
    values[field.name] = value;
  }
  if (problems.length) {
    throw new KeyError(
      `this workflow derives its run key from ${policy.fields.map((f) => `input.${f.name}`).join(', ')}, `
      + `not from a key you choose. ${problems.join('; ')}. `
      + 'Fix the input rather than inventing a different key — a second key would run the job again.',
    );
  }
  // One pass over the TEMPLATE, never re-scanning substituted values, and no
  // $-pattern interpretation (P2/P3 review K1): distinct inputs, distinct keys.
  return policy.template.replace(/\{(\w+)\}/g, (m, name) => (name in values ? values[name] : m));
}
