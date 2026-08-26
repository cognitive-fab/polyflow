// A minimal MCP stdio server — newline-delimited JSON-RPC 2.0 over stdin/stdout.
//
// Hand-rolled on purpose: polyflow ships with one runtime dependency, and this
// is the whole protocol we need (initialize, tools/list, tools/call, ping).
// stdout is the transport, so everything diagnostic goes to stderr.

import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';

export function serve({ name, version, tools, stdin = process.stdin, stdout = process.stdout }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const write = (msg) => stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (msg) => {
    const { id, method, params } = msg;
    // Notifications carry no id and are never answered.
    if (id === undefined || id === null) return;

    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
        });
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, {
          tools: tools.map(({ name: n, description, inputSchema, outputSchema, annotations }) => ({
            name: n, description, inputSchema,
            ...(outputSchema ? { outputSchema } : {}),
            ...(annotations ? { annotations } : {}),
          })),
        });
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) return fail(id, -32602, `unknown tool '${params?.name}'`);
        try {
          const result = await tool.handler(params.arguments ?? {});
          return reply(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          });
        } catch (err) {
          // A tool failure is a RESULT the model must see and reason about, not
          // a protocol error that kills the call.
          return reply(id, {
            content: [{ type: 'text', text: String(err?.message ?? err) }],
            isError: true,
          });
        }
      }
      default:
        return fail(id, -32601, `method not found: ${method}`);
    }
  };

  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return fail(null, -32700, 'parse error'); }
    handle(msg).catch((err) => fail(msg.id ?? null, -32603, String(err?.message ?? err)));
  });
  return rl;
}
