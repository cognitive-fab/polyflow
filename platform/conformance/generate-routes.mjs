// Generates conformance/routes.json: policy routes (plan P7.3a), computed by
// the TypeScript kernel. A routed activity (one activity, many tools: the
// OpenAI Agents SDK's `<server>-call-tool-v2`) is classified by a value inside
// its arguments. Every other implementation must reproduce:
//
// - admitted: the admitted policy for a raw policy, digest included (routes
//   are stored only when non-empty, so a policy without them keeps its digest);
// - refused: raw policies whose routes the kernel refuses;
// - target: routeTarget(policy, activityType, args) for JSON-shaped args.
//
// Inputs are stored as JSON text so no loader can reinterpret them first.
import { writeFileSync } from 'node:fs';
import { parsePolicy, routeTarget, PolicyError } from '../packages/kernel/src/index.mjs';

const MCP = 'Tickets-stateless-call-tool-v2';
const base = {
  policy: 'support', version: 1, unlabelled: 'deny',
  effects: {
    invoke_model_activity: { kind: 'model', class: 'none' },
    [`${MCP}:read_ticket`]: { kind: 'read', class: 'none', labels: ['reads-private'] },
    [`${MCP}:issue_refund`]: { kind: 'refund', class: 'irreversible' },
  },
  rules: [{ id: 'one-refund', type: 'at-most', guards: 'refund', n: 1 }],
};

const admittedCases = [
  ['with routes', { ...base, routes: { [MCP]: '0.tool_name' } }],
  ['without routes: no routes key, digest unchanged', base],
  ['empty routes are not stored', { ...base, routes: {} }],
  ['two routes', { ...base, routes: { [MCP]: '0.tool_name', 'Other-call-tool': '0' } }],
];

const admitted = admittedCases.map(([name, raw]) => ({ name, raw: JSON.stringify(raw), admitted: parsePolicy(raw) }));

const refused = [
  ['a path with a space', { [MCP]: '0. tool_name' }],
  ['an empty path', { [MCP]: '' }],
  ['a leading dot', { [MCP]: '.tool_name' }],
  ['a bracket index', { [MCP]: 'args[0]' }],
  ['not a string', { [MCP]: 0 }],
].map(([name, routes]) => {
  try {
    parsePolicy({ ...base, routes });
    throw new Error(`expected '${name}' to be refused`);
  } catch (err) {
    if (!(err instanceof PolicyError)) throw err;
    return { name, raw: JSON.stringify({ ...base, routes }) };
  }
});

const policy = parsePolicy({ ...base, routes: { [MCP]: '0.tool_name', Deep: '1.a.0.b', Top: '0' } });
const targetCases = [
  ['tool name from the dataclass argument', MCP, [{ tool_name: 'issue_refund', arguments: { id: 'T-1' }, factory_argument: null, meta: null }]],
  ['another tool', MCP, [{ tool_name: 'read_ticket', arguments: null }]],
  ['not routed', 'invoke_model_activity', [{ tool_name: 'issue_refund' }]],
  ['missing key', MCP, [{ name: 'issue_refund' }]],
  ['empty string', MCP, [{ tool_name: '' }]],
  ['number value', MCP, [{ tool_name: 7 }]],
  ['null value', MCP, [{ tool_name: null }]],
  ['no arguments', MCP, []],
  ['args is not a list', MCP, { 0: { tool_name: 'x' } }],
  ['a string is not walked', MCP, ['tool_name']],
  ['deep path through arrays and objects', 'Deep', [0, { a: [{ b: 'found' }] }]],
  ['an object with a numeric key', 'Deep', [0, { a: { '0': { b: 'object key' } } }]],
  ['index past the end', 'Deep', [0, { a: [] }]],
  ['top-level string argument', 'Top', ['direct']],
  ['non-ASCII value', MCP, [{ tool_name: 'réfund' }]],
];
const target = targetCases.map(([name, activityType, args]) => ({
  name, activityType, args: JSON.stringify(args), target: routeTarget(policy, activityType, args),
}));
// A leading-zero index: JS Number('01') is 1, so the route reads index 1.
target.push({ name: 'leading-zero index', activityType: 'Lz', args: JSON.stringify([['a', 'b']]), target: routeTarget({ routes: { Lz: '0.01' } }, 'Lz', [['a', 'b']]), routes: { Lz: '0.01' } });

writeFileSync(new URL('./routes.json', import.meta.url), `${JSON.stringify({
  version: 1,
  rule: 'routes: { activityType: dotted path into the argument list }; stored only when non-empty; routeTarget walks arrays by decimal index and objects by own key; a non-empty string value gives "<type>:<value>", anything else "<type>:?"',
  admitted, refused, policy, target,
}, null, 2)}\n`);
console.log(`wrote ${admitted.length} admitted, ${refused.length} refused, ${target.length} target cases`);
