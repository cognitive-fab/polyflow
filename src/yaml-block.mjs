// A minimal, conservative editor for one block of a YAML config file.
//
// Hermes keeps its MCP servers in ~/.hermes/config.yaml under a top-level
// `mcp_servers:` key, alongside everything else the user has configured. We
// have no YAML parser and will not round-trip someone's live config through a
// hand-rolled one — comments, anchors and formatting would not survive.
//
// So this works at the line level and refuses anything it cannot do safely:
// find the `mcp_servers:` block, replace our own entry inside it or add one,
// and leave every other byte exactly as it was.

const INDENT = '  ';

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Lines belonging to the block that starts at `start`: its body is everything
 * indented *deeper* than the key line. A sibling at the same depth ends it —
 * without that, replacing one server would swallow the ones after it.
 */
function blockExtent(lines, start) {
  const depth = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '' || indentOf(line) > depth) end += 1;
    else break;
  }
  // Do not swallow trailing blank lines that separate top-level keys.
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return end;
}

/** Index of `name:` as a direct child of the block body, or -1. */
function childIndex(lines, from, to, name) {
  const want = new RegExp(`^${INDENT}${name}:\\s*$`);
  for (let i = from; i < to; i += 1) if (want.test(lines[i])) return i;
  return -1;
}

/**
 * Insert or replace `name` under the top-level `key` block.
 *
 * @param {string} text     current file contents ('' for a new file)
 * @param {string} key      top-level key, e.g. 'mcp_servers'
 * @param {string} name     entry name, e.g. 'polyflow'
 * @param {string[]} body   entry body lines, already indented relative to the
 *                          entry (no leading `name:` line)
 * @returns {{text: string, action: 'created'|'added'|'replaced'}}
 */
export function upsertBlockEntry(text, key, name, body) {
  // The entry name sits one level in; its body sits one level inside that.
  const entry = [`${INDENT}${name}:`, ...body.map((l) => `${INDENT}${INDENT}${l}`)];

  if (text.trim() === '') {
    return { text: [`${key}:`, ...entry, ''].join('\n'), action: 'created' };
  }

  const lines = text.split('\n');
  const keyAt = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));

  if (keyAt === -1) {
    // No such block yet: append one, leaving the rest untouched.
    const sep = lines[lines.length - 1].trim() === '' ? [] : [''];
    return {
      text: [...lines, ...sep, `${key}:`, ...entry, ''].join('\n'),
      action: 'added',
    };
  }

  const end = blockExtent(lines, keyAt);
  const at = childIndex(lines, keyAt + 1, end, name);

  if (at === -1) {
    return {
      text: [...lines.slice(0, keyAt + 1), ...entry, ...lines.slice(keyAt + 1)].join('\n'),
      action: 'added',
    };
  }

  const childEnd = blockExtent(lines, at);
  return {
    text: [...lines.slice(0, at), ...entry, ...lines.slice(childEnd)].join('\n'),
    action: 'replaced',
  };
}

/** YAML body lines for an MCP stdio server. Values are quoted, never templated. */
export function stdioServerBody({ command, args = [], env = {}, extra = {} }) {
  const q = (v) => JSON.stringify(String(v));
  const out = [`command: ${q(command)}`];
  if (args.length) out.push(`args: [${args.map(q).join(', ')}]`);
  if (Object.keys(env).length) {
    out.push('env:');
    for (const [k, v] of Object.entries(env)) out.push(`${INDENT}${k}: ${q(v)}`);
  }
  for (const [k, v] of Object.entries(extra)) {
    out.push(typeof v === 'string' ? `${k}: ${v}` : `${k}: ${JSON.stringify(v)}`);
  }
  return out;
}
