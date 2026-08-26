#!/usr/bin/env node
// Register polyflow with an agent host, or print the entry for one.
//
//   node bin/polyflow-install.mjs [--host NAME] [--print] [--agent A] [--workspace W]
//
//   --host openworker   OpenWorker's global mcpServers file          (default)
//   --host kiro         Kiro / Kiro Crew user or workspace config
//   --host claude-code  .mcp.json in the current directory
//   --host hermes       ~/.hermes/config.yaml, under mcp_servers:
//   --host nemo         NVIDIA NeMo Agent Toolkit — prints YAML
//   --host registry     AWS Agent Registry — prints the CLI call
//   --host generic      prints the mcpServers entry for any MCP client
//
//   --print             show what would be written, write nothing
//   --scope workspace   for --host kiro: write into ./.kiro instead of ~/.kiro
//   --agent NAME        agent-class area (default openworker/cowork)
//   --workspace NAME    instance area (default the current directory's name)
//   --name KEY          server key in mcpServers (default polyflow) — use a
//                       second key to register a second workspace alongside
//   --db PATH           run store (default ~/.polyflow when installed globally)
//   --workflows PATH    workflow library directory
//
// Only the OpenWorker path has been exercised end to end. The others are built
// from each host's documented configuration format.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { upsertBlockEntry, stdioServerBody } from '../src/yaml-block.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;

const argv = process.argv.slice(2);

/** Accepts both `--k v` and `--k=v`; an unknown `--k=v` is an error, not a
 *  silently-ignored argument that installs somewhere the caller did not ask for. */
const KNOWN = new Set(['host', 'print', 'scope', 'agent', 'workspace', 'name', 'db', 'workflows']);
for (const arg of argv) {
  if (!arg.startsWith('--')) continue;
  const key = arg.slice(2).split('=')[0];
  if (!KNOWN.has(key)) {
    console.error(`unknown option --${key}. Known: ${[...KNOWN].map((k) => `--${k}`).join(' ')}`);
    process.exit(2);
  }
}
const flag = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

/** `~` in an env var or a flag is the user's home, the way a shell would read it. */
const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[\\/]/, '')) : p);

const AGENT = flag('agent', 'openworker/cowork');
const WORKSPACE = flag('workspace', basename(process.cwd()));
const SERVER_KEY = flag('name', 'polyflow');
const SERVER = resolve(ROOT, 'bin', 'polyflow-mcp.mjs');

// A global install puts ROOT inside node_modules, which the next `npm i -g`
// deletes and re-extracts. Durable run state must not live there, and neither
// should workflows the user edits.
const PACKAGED = /[\\/]node_modules[\\/]polyflow$/.test(ROOT);
const HOME_DIR = join(homedir(), '.polyflow');
const DB = resolve(expand(flag('db', PACKAGED ? join(HOME_DIR, 'polyflow.sqlite') : join(ROOT, '.polyflow', 'polyflow.sqlite'))));
const WORKFLOWS = resolve(expand(flag('workflows', PACKAGED ? join(HOME_DIR, 'workflows') : join(ROOT, 'workflows'))));
const DESCRIPTION =
  'Runs checked, resumable workflows. Start one, do the work order it hands back with the tool it names, report the result.';

const env = {
  POLYFLOW_WORKFLOWS: WORKFLOWS,
  POLYFLOW_DB: DB,
  POLYFLOW_AGENT: AGENT,
  POLYFLOW_INSTANCE: WORKSPACE,
};

/** The standard mcpServers entry every MCP client understands. */
const mcpEntry = (extra = {}) => ({
  command: process.execPath,
  args: [SERVER],
  cwd: ROOT,
  env,
  ...extra,
});

// polyflow's own tools reach nothing outside this machine — the run's real side
// effects are the agent's tools, which keep their own gates. Prompting on every
// report would put a dialog between the agent and its own bookkeeping.
const OPENWORKER_EXTRA = {
  requires_approval: false,
  // Honoured with upstream/0001-mcp-per-tool-risk-level.patch applied, ignored
  // without it.
  tool_risk: { workflow_list: 'low', workflow_state: 'low', workflow_journal: 'low' },
};

function coworkerStateDir() {
  // OpenWorker's own state_dir() expands `~`; resolving it literally would write
  // a config file it never reads.
  if (process.env.COWORKER_STATE_DIR) return resolve(expand(process.env.COWORKER_STATE_DIR));
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'coworker');
  return join(homedir(), '.config', 'coworker');
}

const HOSTS = {
  openworker: {
    label: 'OpenWorker',
    target: () => join(coworkerStateDir(), 'mcp.json'),
    entry: () => mcpEntry(OPENWORKER_EXTRA),
    after: 'Restart OpenWorker to pick it up.',
  },
  kiro: {
    label: 'Kiro / Kiro Crew',
    target: () => flag('scope', 'user') === 'workspace'
      ? join(process.cwd(), '.kiro', 'settings', 'mcp.json')
      : join(homedir(), '.kiro', 'settings', 'mcp.json'),
    entry: () => mcpEntry({ disabled: false, autoApprove: ['workflow_list', 'workflow_state', 'workflow_journal'] }),
    after: 'Kiro reloads MCP config on save; otherwise reconnect the server from the MCP panel.',
  },
  'claude-code': {
    label: 'Claude Code',
    target: () => join(process.cwd(), '.mcp.json'),
    entry: () => mcpEntry(),
    after: 'Run `claude` in this directory and approve the project server when prompted.',
  },
};

const host = flag('host', 'openworker');

// --- Hermes: YAML, edited line by line -------------------------------------
//
// Hermes keeps MCP servers in ~/.hermes/config.yaml alongside everything else
// it is configured with. We have no YAML parser, so the edit is textual and
// narrow (see src/yaml-block.mjs), the previous file is kept as .bak, and the
// write is a rename.

if (host === 'hermes') {
  const hermesHome = process.env.HERMES_HOME
    ? resolve(expand(process.env.HERMES_HOME))
    : join(homedir(), '.hermes');
  const target = join(hermesHome, 'config.yaml');
  const body = stdioServerBody({
    command: process.execPath,
    args: [SERVER],
    env,
    // The read-only tools carry readOnlyHint, so Hermes' `untrusted` tier lets
    // them through without a prompt while every write still stops for one.
    extra: { trust: 'untrusted' },
  });

  if (has('print')) {
    console.log(`# Hermes — merge into ${target}`);
    console.log(upsertBlockEntry('', 'mcp_servers', SERVER_KEY, body).text);
    process.exit(0);
  }

  const before = existsSync(target) ? readFileSync(target, 'utf-8') : '';
  let result;
  try {
    result = upsertBlockEntry(before, 'mcp_servers', SERVER_KEY, body);
  } catch (err) {
    console.error(`could not edit ${target} safely: ${err.message}`);
    console.error('Run again with --print and paste the block in by hand.');
    process.exit(1);
  }

  mkdirSync(dirname(target), { recursive: true });
  if (before) writeFileSync(`${target}.bak`, before, 'utf-8');
  const tmp = `${target}.polyflow.tmp`;
  writeFileSync(tmp, result.text, 'utf-8');
  renameSync(tmp, target);

  console.log(`${result.action} "${SERVER_KEY}" for Hermes`);
  console.log(`  file:          ${target}${before ? ` (previous kept as ${target}.bak)` : ''}`);
  console.log(`  agent area:    ${AGENT}`);
  console.log(`  instance area: ${WORKSPACE}`);
  console.log(`  workflows:     ${WORKFLOWS}`);
  console.log(`  run store:     ${DB}`);
  console.log('Hermes reloads config.yaml on save. polyflow is stdio, so there is no `hermes mcp login` step.');
  process.exit(0);
}

// --- print-only hosts --------------------------------------------------------

if (host === 'nemo') {
  const yamlArgs = [SERVER].map((a) => `"${a}"`).join(', ');
  console.log(`# NVIDIA NeMo Agent Toolkit — add to your workflow YAML.
# Requires the nvidia-nat-mcp package.

function_groups:
  polyflow:
    _type: mcp_client
    server:
      transport: stdio
      command: "${process.execPath.replace(/\\/g, '/')}"
      args: [${yamlArgs.replace(/\\/g, '/')}]
      env:
${Object.entries(env).map(([k, v]) => `        ${k}: "${String(v).replace(/\\/g, '/')}"`).join('\n')}

workflow:
  _type: react_agent
  tool_names:
    - polyflow`);
  process.exit(0);
}

if (host === 'registry') {
  // polyflow speaks stdio, so the registry cannot synchronize metadata from an
  // endpoint — publish a manual MCP record instead.
  const descriptorData = JSON.stringify({
    name: 'cognitive-fab/polyflow',
    description: DESCRIPTION,
    version: VERSION,
  });
  const descriptors = JSON.stringify({
    mcpServer: { data: descriptorData, dataSchemaVersion: '2025-12-11' },
  });
  console.log(`# AWS Agent Registry — publish polyflow so agents in the org can discover it.
# stdio servers cannot be synchronized from an endpoint, so this is a manual record.

aws agent-registry-control create-registry-record \\
  --registry-id "<registryId>" \\
  --name "polyflow" \\
  --display-name "polyflow" \\
  --record-type MCP \\
  --descriptors '${descriptors.replace(/'/g, "'\\''")}' \\
  --record-version "${VERSION}" \\
  --region us-east-1

aws agent-registry-control submit-registry-record-for-approval \\
  --registry-id "<registryId>" --record-id "<recordId>" --region us-east-1`);
  process.exit(0);
}

if (host === 'generic' || !HOSTS[host]) {
  if (host !== 'generic') {
    console.error(`unknown --host '${host}'. Known: ${Object.keys(HOSTS).join(', ')}, nemo, registry, generic`);
  }
  console.log(JSON.stringify({ mcpServers: { [SERVER_KEY]: mcpEntry() } }, null, 2));
  process.exit(host === 'generic' ? 0 : 2);
}

// --- file-writing hosts ------------------------------------------------------

const { label, target: targetFor, entry: entryFor, after } = HOSTS[host];
const target = targetFor();
const entry = entryFor();

if (has('print')) {
  console.log(`# ${label}`);
  console.log(`# target: ${target}`);
  console.log(JSON.stringify({ mcpServers: { [SERVER_KEY]: entry } }, null, 2));
  process.exit(0);
}

let doc = {};
if (existsSync(target)) {
  try {
    doc = JSON.parse(readFileSync(target, 'utf-8'));
  } catch (err) {
    console.error(`refusing to overwrite unreadable ${target}: ${err.message}`);
    process.exit(1);
  }
}
const servers = doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {};
const replacing = Boolean(servers[SERVER_KEY]);
servers[SERVER_KEY] = entry;

// Write-then-rename: this file holds every other MCP server the user has, and a
// truncated write would lose all of them. OpenWorker's own writer does the same.
mkdirSync(dirname(target), { recursive: true });
const tmp = `${target}.polyflow.tmp`;
writeFileSync(tmp, JSON.stringify({ ...doc, mcpServers: servers }, null, 2), 'utf-8');
renameSync(tmp, target);

console.log(`${replacing ? 'updated' : 'added'} "${SERVER_KEY}" for ${label}`);
console.log(`  file:          ${target}`);
console.log(`  agent area:    ${AGENT}`);
console.log(`  instance area: ${WORKSPACE}`);
console.log(`  workflows:     ${env.POLYFLOW_WORKFLOWS}`);
console.log(`  run store:     ${env.POLYFLOW_DB}`);
if (PACKAGED && !existsSync(WORKFLOWS)) {
  console.log(`
No workflows at ${WORKFLOWS} yet. Copy the bundled examples there:`);
  console.log(`  cp -r "${join(ROOT, 'workflows')}/." "${WORKFLOWS}"`);
}
console.log(after);
