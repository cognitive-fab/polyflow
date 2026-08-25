#!/usr/bin/env node
// Register polyflow with an agent host, or print the entry for one.
//
//   node bin/polyflow-install.mjs [--host NAME] [--print] [--agent A] [--workspace W]
//
//   --host openworker   OpenWorker's global mcpServers file          (default)
//   --host kiro         Kiro / Kiro Crew user or workspace config
//   --host claude-code  .mcp.json in the current directory
//   --host nemo         NVIDIA NeMo Agent Toolkit — prints YAML
//   --host registry     AWS Agent Registry — prints the CLI call
//   --host generic      prints the mcpServers entry for any MCP client
//
//   --print             show what would be written, write nothing
//   --scope workspace   for --host kiro: write into ./.kiro instead of ~/.kiro
//   --agent NAME        agent-class area (default openworker/cowork)
//   --workspace NAME    instance area (default the current directory's name)
//
// Only the OpenWorker path has been exercised end to end. The others are built
// from each host's documented configuration format.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const AGENT = flag('agent', 'openworker/cowork');
const WORKSPACE = flag('workspace', basename(process.cwd()));
const SERVER = resolve(ROOT, 'bin', 'polyflow-mcp.mjs');
const DESCRIPTION =
  'Runs checked, resumable workflows. Start one, do the work order it hands back with the tool it names, report the result.';

const env = {
  POLYFLOW_WORKFLOWS: resolve(ROOT, 'workflows'),
  POLYFLOW_DB: resolve(ROOT, '.polyflow', 'polyflow.sqlite'),
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
  if (process.env.COWORKER_STATE_DIR) return resolve(process.env.COWORKER_STATE_DIR);
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
  console.log(JSON.stringify({ mcpServers: { polyflow: mcpEntry() } }, null, 2));
  process.exit(host === 'generic' ? 0 : 2);
}

// --- file-writing hosts ------------------------------------------------------

const { label, target: targetFor, entry: entryFor, after } = HOSTS[host];
const target = targetFor();
const entry = entryFor();

if (has('print')) {
  console.log(`# ${label}`);
  console.log(`# target: ${target}`);
  console.log(JSON.stringify({ mcpServers: { polyflow: entry } }, null, 2));
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
const replacing = Boolean(servers.polyflow);
servers.polyflow = entry;

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify({ ...doc, mcpServers: servers }, null, 2), 'utf-8');

console.log(`${replacing ? 'updated' : 'added'} "polyflow" for ${label}`);
console.log(`  file:          ${target}`);
console.log(`  agent area:    ${AGENT}`);
console.log(`  instance area: ${WORKSPACE}`);
console.log(`  workflows:     ${env.POLYFLOW_WORKFLOWS}`);
console.log(after);
