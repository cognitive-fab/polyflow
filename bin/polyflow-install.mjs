#!/usr/bin/env node
// Register polyflow with OpenWorker (or print the entry for any other MCP host).
//
// Writes into OpenWorker's global `mcpServers` file, merging rather than
// clobbering — the same file the Connectors page edits. Resolution matches
// coworker/secrets.py:state_dir():
//
//   $COWORKER_STATE_DIR/mcp.json
//   Windows: %APPDATA%\coworker\mcp.json
//   else:    ~/.config/coworker/mcp.json
//
//   node bin/polyflow-install.mjs [--print] [--agent NAME] [--workspace PATH]
//     --print       show the entry and the target path, write nothing
//     --agent       agent-class area (default openworker/cowork)
//     --workspace   instance area (default the current directory's name)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

function stateDir() {
  if (process.env.COWORKER_STATE_DIR) return resolve(process.env.COWORKER_STATE_DIR);
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'coworker');
  return join(homedir(), '.config', 'coworker');
}

const entry = {
  command: process.execPath,
  args: [resolve(ROOT, 'bin', 'polyflow-mcp.mjs')],
  cwd: ROOT,
  env: {
    POLYFLOW_WORKFLOWS: resolve(ROOT, 'workflows'),
    POLYFLOW_DB: resolve(ROOT, '.polyflow', 'polyflow.sqlite'),
    POLYFLOW_AGENT: flag('agent', 'openworker/cowork'),
    POLYFLOW_INSTANCE: flag('workspace', basename(process.cwd())),
  },
  // polyflow tools reach nothing outside this machine — the run's real side
  // effects are the agent's OWN tools, which keep their own gates. Prompting on
  // every workflow_report would put a dialog between the agent and its own
  // bookkeeping.
  requires_approval: false,
  // Honoured with upstream/0001-mcp-per-tool-risk-level.patch applied; ignored
  // (harmlessly) without it. See FINDINGS-phase2.md.
  tool_risk: {
    workflow_list: 'low',
    workflow_state: 'low',
    workflow_journal: 'low',
  },
};

const target = join(stateDir(), 'mcp.json');

if (argv.includes('--print')) {
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

console.log(`${replacing ? 'updated' : 'added'} "polyflow" in ${target}`);
console.log(`  agent area:    ${entry.env.POLYFLOW_AGENT}`);
console.log(`  instance area: ${entry.env.POLYFLOW_INSTANCE}`);
console.log(`  workflows:     ${entry.env.POLYFLOW_WORKFLOWS}`);
console.log('Restart OpenWorker (or reopen the session) to pick it up.');
