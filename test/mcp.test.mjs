// The MCP surface, over real stdio — the way OpenWorker (or any MCP agent)
// will actually reach it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = resolve(import.meta.dirname, '..');

test('initialize, tools/list, tools/call over stdio', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyflow-mcp-'));
  const child = spawn(process.execPath, ['--no-warnings', join(ROOT, 'bin', 'polyflow-mcp.mjs')], {
    cwd: ROOT,
    env: { ...process.env, POLYFLOW_DB: join(dir, 'mcp.sqlite'), POLYFLOW_AGENT: 'openworker/cowork', POLYFLOW_INSTANCE: 'acme' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const inbox = [];
  const waiters = [];
  lines.on('line', (l) => {
    const msg = JSON.parse(l);
    const i = waiters.findIndex((w) => w.id === msg.id);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });

  let nextId = 0;
  const rpc = (method, params) => {
    const id = ++nextId;
    const hit = inbox.findIndex((m) => m.id === id);
    const p = hit >= 0
      ? Promise.resolve(inbox.splice(hit, 1)[0])
      : new Promise((resolve, reject) => {
          waiters.push({ id, resolve });
          setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
        });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  };

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(init.result.serverInfo.name, 'polyflow');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const listed = await rpc('tools/list', {});
  const names = listed.result.tools.map((x) => x.name).sort();
  assert.deepEqual(names, [
    'workflow_journal', 'workflow_list', 'workflow_report',
    'workflow_signal', 'workflow_start', 'workflow_state',
  ]);
  for (const tool of listed.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} must declare an object schema`);
    assert.ok(tool.description.length > 20);
    // Hosts with a trust tier prompt on anything not marked read-only, so every
    // tool has to say which it is — and none of them reach the network.
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} annotations`);
    assert.equal(tool.annotations.openWorldHint, false, `${tool.name} openWorldHint`);
  }
  const reads = listed.result.tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(reads, ['workflow_journal', 'workflow_list', 'workflow_state']);

  // Hosts that validate structuredContent against outputSchema fall back to
  // unconstrained JSON on vocabulary they do not support, so the schemas stay
  // in the plain subset and declare no `required` (an error reply carries
  // `error` instead of a view).
  const SUPPORTED = new Set(['object', 'array', 'string', 'number', 'boolean']);
  const walk = (schema, path) => {
    assert.ok(SUPPORTED.has(schema.type), `${path}: unsupported type ${JSON.stringify(schema.type)}`);
    assert.equal(schema.required, undefined, `${path}: must not declare required`);
    for (const key of ['oneOf', 'anyOf', 'allOf', '$ref', 'not']) {
      assert.equal(schema[key], undefined, `${path}: must not use ${key}`);
    }
    for (const [k, v] of Object.entries(schema.properties ?? {})) walk(v, `${path}.${k}`);
    if (schema.items) walk(schema.items, `${path}[]`);
  };
  for (const tool of listed.result.tools) {
    assert.ok(tool.outputSchema, `${tool.name} must advertise an outputSchema`);
    walk(tool.outputSchema, tool.name);
  }

  const called = await rpc('tools/call', { name: 'workflow_list', arguments: {} });
  assert.ok(!called.result.isError);
  const wf = called.result.structuredContent.workflows.find((w) => w.name === 'customer-brief');
  assert.equal(wf.admitted, true);

  const started = await rpc('tools/call', {
    name: 'workflow_start',
    arguments: { workflow: 'customer-brief', input: { date: '2026-08-25' } },
  });
  assert.equal(started.result.structuredContent.next[0].tool, 'github_search_issues');

  // Drift guard: everything a call actually returns has to be declared, and no
  // field may be null — absent is representable in the schema subset, null is not.
  const schemaOf = (n) => listed.result.tools.find((t) => t.name === n).outputSchema;
  const conforms = (value, schema, path) => {
    assert.notEqual(value, null, `${path} is null; omit the field instead`);
    if (schema.type === 'object' && schema.properties) {
      for (const [k, v] of Object.entries(value)) {
        assert.ok(schema.properties[k], `${path}.${k} is returned but not declared`);
        conforms(v, schema.properties[k], `${path}.${k}`);
      }
    } else if (schema.type === 'array' && schema.items) {
      value.forEach((item, i) => conforms(item, schema.items, `${path}[${i}]`));
    } else if (schema.type !== 'object') {
      assert.equal(typeof value, schema.type, `${path} should be ${schema.type}`);
    }
  };
  conforms(started.result.structuredContent, schemaOf('workflow_start'), 'workflow_start');
  const catalog = await rpc('tools/call', { name: 'workflow_list', arguments: {} });
  conforms(catalog.result.structuredContent, schemaOf('workflow_list'), 'workflow_list');
  const log = await rpc('tools/call', {
    name: 'workflow_journal',
    arguments: { instance: started.result.structuredContent.instance },
  });
  conforms(log.result.structuredContent, schemaOf('workflow_journal'), 'workflow_journal');

  // A tool failure must come back as a readable result, not a protocol error.
  const bad = await rpc('tools/call', { name: 'workflow_state', arguments: { instance: 'nope' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /unknown instance/);
});
