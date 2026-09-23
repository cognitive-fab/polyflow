// @cognitive-fab/polyflow-gateway — polyflow's MCP work-order tools over Temporal.
import { makeTools } from '@cognitive-fab/polyflow';
import { TemporalPolyflow } from './temporal-polyflow.mjs';

export { TemporalPolyflow } from './temporal-polyflow.mjs';

/**
 * The tool set: the six unchanged polyflow tools, plus `workflow_claim` for
 * runs where more than one participant may take an order (polycrew's protocol).
 */
export function gatewayTools(pf) {
  return makeTools(pf, [{
    name: 'workflow_claim',
    description:
      'Claim a work order before doing it, when a run has more than one participant. '
      + 'A claim is a lease: only the holder may report the order until it lapses. A refused '
      + 'claim is an answer naming the holder, not an error — move on to another order.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', required: ['order_id'], properties: { order_id: { type: 'string', description: 'order_id from a work order' } } },
    handler: async ({ order_id }) => pf.claim(order_id),
  }]);
}

export function createGateway(options) {
  const pf = new TemporalPolyflow(options);
  return { pf, tools: gatewayTools(pf) };
}
