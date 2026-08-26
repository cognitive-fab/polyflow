// The YAML editor touches a file holding everything else the user configured,
// so what matters is what it leaves alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { upsertBlockEntry, stdioServerBody } from '../src/yaml-block.mjs';

const body = stdioServerBody({
  command: '/usr/bin/node',
  args: ['/opt/polyflow/bin/polyflow-mcp.mjs'],
  env: { POLYFLOW_AGENT: 'hermes' },
});

test('an empty file becomes a config with just our block', () => {
  const { text, action } = upsertBlockEntry('', 'mcp_servers', 'polyflow', body);
  assert.equal(action, 'created');
  assert.match(text, /^mcp_servers:\n {2}polyflow:\n {4}command: "\/usr\/bin\/node"/);
});

test('a config with no mcp_servers keeps every line it had', () => {
  const before = 'model: hermes-4\ntemperature: 0.2\n';
  const { text, action } = upsertBlockEntry(before, 'mcp_servers', 'polyflow', body);
  assert.equal(action, 'added');
  assert.ok(text.startsWith(before));
  assert.match(text, /mcp_servers:\n {2}polyflow:/);
});

test('other servers survive, comments and all', () => {
  const before = [
    '# my setup',
    'mcp_servers:',
    '  filesystem:',
    '    command: "npx"',
    '    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]',
    '  stripe:',
    '    url: "https://mcp.stripe.com"',
    '    auth: oauth',
    '',
    'model: hermes-4',
    '',
  ].join('\n');

  const { text, action } = upsertBlockEntry(before, 'mcp_servers', 'polyflow', body);
  assert.equal(action, 'added');
  assert.match(text, /^# my setup/);
  assert.match(text, / {2}filesystem:/);
  assert.match(text, /https:\/\/mcp\.stripe\.com/);
  assert.match(text, / {2}stripe:\n {4}url:/);
  assert.match(text, /^model: hermes-4$/m, 'a later top-level key must not be absorbed');
  assert.match(text, / {2}polyflow:\n {4}command:/);
});

test('re-running replaces our entry and only ours', () => {
  const once = upsertBlockEntry('mcp_servers:\n  filesystem:\n    command: "npx"\n', 'mcp_servers', 'polyflow', body).text;
  const changed = stdioServerBody({ command: '/usr/local/bin/node', args: ['/elsewhere/mcp.mjs'] });
  const { text, action } = upsertBlockEntry(once, 'mcp_servers', 'polyflow', changed);

  assert.equal(action, 'replaced');
  assert.equal((text.match(/ {2}polyflow:/g) || []).length, 1, 'no duplicate entry');
  assert.match(text, /\/usr\/local\/bin\/node/);
  assert.doesNotMatch(text, /\/usr\/bin\/node/);
  assert.match(text, / {2}filesystem:\n {4}command: "npx"/, 'the neighbour is untouched');
});

test('values are quoted, so a Windows path is not read as YAML syntax', () => {
  const win = stdioServerBody({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Users\\me\\polyflow\\bin\\polyflow-mcp.mjs'],
    env: { POLYFLOW_DB: 'C:\\Users\\me\\.polyflow\\polyflow.sqlite' },
  });
  const { text } = upsertBlockEntry('', 'mcp_servers', 'polyflow', win);
  assert.match(text, /command: "C:\\\\Program Files\\\\nodejs\\\\node\.exe"/);
  assert.match(text, /POLYFLOW_DB: "C:\\\\Users\\\\me\\\\\.polyflow\\\\polyflow\.sqlite"/);
});
