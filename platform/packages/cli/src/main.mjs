// The polyflow command.
//
//   polyflow verify <run.jsonl> [--trust trust.json] [--json]
//   polyflow export <history.json> --out <dir> [--header-keys keys.json]
//   polyflow keygen [--id <keyId>] [--out <dir>]
//
// Every command is deterministic, offline and model-free. Exit codes: 0 ok,
// 1 the thing checked is not ok, 2 the command itself was used wrongly.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  verifyBundle, verifyThread, readJsonl, ledgerFromHistory, fileSink, generateSigningKey,
} from '@cognitive-fab/polyflow-temporal';
import { admit } from './admit.mjs';
import { admitPolicy, PolicyError } from '@cognitive-fab/polyflow-kernel';
import { vet } from '@cognitive-fab/polyflow-temporal';

class Usage extends Error {}

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[name] = true;
      else { flags[name] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

const USAGE = `polyflow — offline tools for Polyflow for Temporal

  polyflow verify <run.jsonl> [--trust trust.json] [--allow-open] [--unsigned] [--json]
  polyflow verify --thread <dir> [--trust trust.json] [--unsigned] [--json]
      every chain of a LangGraph thread as one record: one root, resolving links, one open chain at most
      check a run's ledger: chain, signatures, coverage of the last event, and
      closure. Heads are read from <run>.heads.jsonl beside it. trust.json maps
      keyId -> public key PEM. --allow-open accepts a run still in progress;
      --unsigned checks a history-derived ledger (polyflow export) for
      consistency alone, and says so.
  polyflow export <history.json> --out <dir> [--header-keys keys.json]
      rebuild a run's ledger from a Temporal history (temporal workflow show
      --output json, or a client's fetchHistory()) into a file sink.
  polyflow keygen [--id <keyId>] [--out <dir>]
      make an ed25519 deployment key pair and a trust store entry.
  polyflow vet --old <dir> --new <dir> --fleet fleet.json [--trust trust.json] [--allow-uncertified] [--allow-empty-fleet] [--json]
      decide, per live run, whether a new version may take it over: auto-upgrade,
      migrate (with the migrated state), or pin — polyvers over each distinct
      live state. The new version must be admitted (its certificate matches its
      files, and is signed by a trusted key when --trust is given).
      fleet.json: [{ workflowId, state, openKinds? }].
  polyflow policy <policy.json> [--out admitted.json]
      admit a policy (every rule known, every guarded kind reachable) and print
      the ADMITTED form, with its digest — what workers in any language load.
  polyflow admit <machine-dir> [--key key.json] [--accept-bound "<why>"] [--json]
      run every check the machine supports (check-effects, structural, policy)
      and, only if all pass, write polyflow.certificate.json, signed with --key.

Consistency checks, not proofs. admit and vet LOAD the candidate's code (its
invariants, its migration) in this process, with your privileges: run them on
code you would run anyway, in CI, with no credentials in the environment.`;

/** `polyflow verify --thread <dir>`: every chain of a LangGraph thread, as one record (P10 review VF1). */
function verifyThreadDir(dir, flags, out) {
  if (!existsSync(dir)) throw new Usage(`no such directory: ${dir}`);
  const chains = [];
  try {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.endsWith('.heads.jsonl')).sort()) {
      const events = readJsonl(join(dir, f), { strict: true }).sort((a, b) => a.seq - b.seq);
      const headsFile = join(dir, f.replace(/\.jsonl$/, '.heads.jsonl'));
      chains.push({ events, heads: existsSync(headsFile) ? readJsonl(headsFile, { strict: true }) : [] });
    }
  } catch (err) {
    out(`  ✖ ${err.message}`);
    out('  NOT OK');
    return 1;
  }
  const trust = flags.trust ? JSON.parse(readFileSync(flags.trust, 'utf-8')) : {};
  const r = verifyThread(chains, { trust, unsigned: Boolean(flags.unsigned) });
  if (flags.json) { out(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  out(`${dir} — ${r.chains} chain(s)`);
  out(`  root        ${r.roots.join(', ') || '(none)'}`);
  for (const l of r.links) out(`  link        ${l.from} → ${l.to}`);
  out(`  open        ${r.open.join(', ') || '(none: every chain closed)'}`);
  for (const p of r.problems) out(`  ✖ ${p}`);
  out(r.ok ? '  OK — one thread: every chain verifies, and the links resolve. A consistency check, not a proof.' : '  NOT OK');
  return r.ok ? 0 : 1;
}

function verify({ pos, flags }, out) {
  // `--thread` names a directory: given bare (`--thread --json dir`), the directory is the positional.
  if (flags.thread === true && pos[0]) return verifyThreadDir(pos[0], flags, out);
  if (flags.thread === true) throw new Usage('verify --thread needs a thread directory');
  if (typeof flags.thread === 'string') return verifyThreadDir(flags.thread, flags, out);
  const file = pos[0];
  if (!file) throw new Usage('verify needs a run ledger file');
  if (!existsSync(file)) throw new Usage(`no such file: ${file}`);
  let events;
  let heads;
  try {
    // Strict: a line that does not parse is a finding, not something to skip.
    events = readJsonl(file, { strict: true }).sort((a, b) => a.seq - b.seq);
    const headsFile = file.replace(/\.jsonl$/, '.heads.jsonl');
    heads = headsFile !== file ? readJsonl(headsFile, { strict: true }) : [];
  } catch (err) {
    out(`  ✖ ${err.message}`);
    out('  NOT OK');
    return 1;
  }
  const trust = flags.trust ? JSON.parse(readFileSync(flags.trust, 'utf-8')) : {};
  const r = verifyBundle({ events, heads, trust, allowOpen: Boolean(flags['allow-open']), unsigned: Boolean(flags.unsigned) });
  if (flags.json) {
    out(JSON.stringify(r, null, 2));
  } else {
    const run = events[0]?.run;
    out(`${run ? `${run.ns}/${run.wf}/${run.run}` : basename(file)} — ${events.length} events`);
    out(r.chain.ok ? `  chain       intact through seq ${r.chain.head.seq}` : `  chain       BROKEN at seq ${r.chain.seq}: ${r.chain.reason}`);
    if (r.chain.ok) {
      if (!flags.unsigned) out(`  signatures  ${r.signatures.length} head(s), ${r.anchored} trusted and anchored${r.signedThrough !== null ? `, signed through seq ${r.signedThrough}` : ''}`);
      out(`  closure     ${r.closed ? 'present — the record is finished' : 'absent — the run is in progress, or the record was truncated'}`);
    }
    for (const p of r.problems) out(`  ✖ ${p}`);
    const verdicts = {
      'closed-and-signed': 'OK — consistent, closed and signed through its last event.',
      'open-and-signed': 'OK (open) — consistent and signed through its last event; the run has not closed.',
      'consistent-unsigned': 'CONSISTENT, UNSIGNED — rebuilt from history; nobody vouched for it.',
    };
    out(r.ok ? `  ${verdicts[r.verdict]} A consistency check, not a proof.` : '  NOT OK');
  }
  return r.ok ? 0 : 1;
}

function exportHistory({ pos, flags }, out) {
  const file = pos[0];
  if (!file || !flags.out) throw new Usage('export needs <history.json> and --out <dir>');
  const history = JSON.parse(readFileSync(file, 'utf-8'));
  // Sealed ledger headers (P2.6) open with the worker's data keys: { keyId: base64 }.
  const headerKeys = typeof flags['header-keys'] === 'string' ? JSON.parse(readFileSync(flags['header-keys'], 'utf-8')) : {};
  const events = ledgerFromHistory(history, { headerKeys });
  if (events.length === 0) {
    out('no ledger events in this history — was the worker running PolyflowPlugin?');
    return 1;
  }
  const r = fileSink(flags.out).write(events, null);
  out(`exported ${r.written} event(s) (${r.skipped} already present) for ${events[0].run.wf}/${events[0].run.run}`);
  out("  unsigned: check it with `polyflow verify --unsigned`. A Continue-as-New chain needs every execution's history.");
  if (r.conflicts.length) {
    out(`  ✖ CONFLICT at seq ${r.conflicts.join(', ')}: the sink holds different events than the history`);
    return 1;
  }
  return 0;
}

function keygen({ flags }, out) {
  const key = generateSigningKey(typeof flags.id === 'string' ? flags.id : 'deployment');
  const dir = typeof flags.out === 'string' ? flags.out : '.';
  mkdirSync(dir, { recursive: true });
  const priv = join(dir, `${key.keyId}.key.json`);
  const trust = join(dir, 'trust.json');
  writeFileSync(priv, JSON.stringify({ keyId: key.keyId, privateKeyPem: key.privateKeyPem }, null, 2), { mode: 0o600 });
  const store = existsSync(trust) ? JSON.parse(readFileSync(trust, 'utf-8')) : {};
  store[key.keyId] = key.publicKeyPem;
  writeFileSync(trust, JSON.stringify(store, null, 2));
  out(`wrote ${priv} (keep it secret) and added '${key.keyId}' to ${trust}`);
  return 0;
}

async function admitCmd({ pos, flags }, out) {
  const dir = pos[0];
  if (!dir) throw new Usage('admit needs a machine directory');
  if (!existsSync(join(dir, 'polyflow.workflow.json'))) throw new Usage(`${dir} has no polyflow.workflow.json`);
  const key = typeof flags.key === 'string' ? JSON.parse(readFileSync(flags.key, 'utf-8')) : null;
  const r = await admit(dir, { key, acceptBound: typeof flags['accept-bound'] === 'string' ? flags['accept-bound'] : null });
  if (flags.json) { out(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  for (const c of r.checks) {
    const extra = c.name === 'check-effects' ? `paths ${c.pathsExplored}, states ${c.statesSeen}` : c.name === 'structural' ? c.items.map((i) => `${i.name}:${i.ok === null ? 'not checked' : i.ok ? 'ok' : 'FAIL'}`).join(' ') : '';
    out(`  ${c.ok ? '✔' : '✖'} ${c.name}${c.bounded ? ' (BOUNDED)' : ''}  ${extra}`);
  }
  for (const p of r.problems) out(`  ✖ ${p}`);
  if (!r.ok) { out('  REFUSED — nothing was certified; the machine cannot run on a worker that requires certificates'); return 1; }
  out(`  ADMITTED ${r.certificate.subject.machine} as ${r.certificate.buildId}${key ? ` (signed by ${key.keyId})` : ' (UNSIGNED: workers will refuse it until it is signed)'}`);
  out(`  guarantees: ${r.guarantees.join(', ')}`);
  out('  exhaustive over the declared domains only. A consistency check, not a proof.');
  return 0;
}

function vetCmd({ flags }, out) {
  if (typeof flags.old !== 'string' || typeof flags.new !== 'string' || typeof flags.fleet !== 'string') throw new Usage('vet needs --old <dir> --new <dir> --fleet fleet.json');
  const fleet = JSON.parse(readFileSync(flags.fleet, 'utf-8'));
  const trust = typeof flags.trust === 'string' ? JSON.parse(readFileSync(flags.trust, 'utf-8')) : null;
  const { reports, ...r } = vet({ oldDir: flags.old, newDir: flags.new, fleet, allowEmptyFleet: Boolean(flags['allow-empty-fleet']), trust, allowUncertified: Boolean(flags['allow-uncertified']) });
  if (flags.json) { out(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  if (r.refused) { out(`  ✖ ${r.refused}`); return 1; }
  out(`  lanes: ${r.lanes.join(', ') || '(none)'}`);
  for (const d of r.decisions) out(`  ${d.decision.padEnd(12)} ${d.workflowId}${d.failed ? `  — ${d.failed.map((f) => `${f.gate}: ${f.first ?? f.summary}`).join('; ')}` : ''}`);
  out(r.ok ? '  PASS — every run can move to the new version.' : '  FAIL — some runs would have to stay on the old version; the gate does not pass by default.');
  return r.ok ? 0 : 1;
}

function policyCmd({ pos, flags }, out) {
  if (!pos[0]) throw new Usage('policy needs a policy file');
  try {
    const admitted = admitPolicy(JSON.parse(readFileSync(pos[0], 'utf-8')));
    const text = `${JSON.stringify(admitted, null, 2)}
`;
    if (typeof flags.out === 'string') { writeFileSync(flags.out, text); out(`admitted ${admitted.policy} v${admitted.version} as ${admitted.digest} -> ${flags.out}`); } else out(text.trimEnd());
    for (const n of admitted.notes) out(`  note: ${n}`);
    return 0;
  } catch (err) {
    if (err instanceof PolicyError) { out(err.message); return 1; }
    throw err;
  }
}

const COMMANDS = { verify, export: exportHistory, keygen, admit: admitCmd, vet: vetCmd, policy: policyCmd };

/** Run the CLI. Returns an exit code; `out` receives each line. */
export function main(argv, out = (l) => process.stdout.write(`${l}\n`)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { out(USAGE); return cmd ? 0 : 2; }
  const fn = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!fn) { out(`unknown command '${cmd}'\n\n${USAGE}`); return 2; }
  const usage = (err) => { if (err instanceof Usage) { out(`${err.message}\n\n${USAGE}`); return 2; } throw err; };
  try {
    const code = fn(parse(rest), out);
    return code instanceof Promise ? code.catch(usage) : code;
  } catch (err) {
    return usage(err);
  }
}
