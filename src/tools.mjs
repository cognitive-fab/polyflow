// The agent-facing surface. Six tools, one loop:
//
//   workflow_start  -> instance + first work order
//   workflow_report -> next work order, or done
//
// The agent never decides what comes next. It reasons about HOW to fulfil one
// order (which is where a model is actually good), runs the tool through its
// own permission gates, and reports the result. The order of operations, the
// retries, the timers and the terminal conditions are the machine's.

const str = (t, d) => ({ type: t, description: d });

export function makeTools(pf) {
  const view = async (instanceId, sinceSeq) => {
    const v = sinceSeq === undefined
      ? await pf.view(instanceId)
      : await pf.settle(instanceId, { sinceSeq });
    return {
      instance: v.instanceId,
      workflow: v.workflow,
      status: v.status,
      state: v.state,
      done: v.done,
      next: v.orders.map((o) => ({
        order_id: o.orderId,
        tool: o.tool,
        target: o.target,
        args: o.args,
        why: o.why,
        attempt: o.attempt,
      })),
      waiting: !v.done && v.orders.length === 0
        ? 'nothing to do right now — the run is waiting on a timer. Re-attach later.'
        : undefined,
    };
  };

  return [
    {
      name: 'workflow_list',
      description:
        'List the workflows this agent knows how to run, with the guarantees each one was ' +
        'admitted under. A workflow that failed its emission check is listed as admitted:false ' +
        'and cannot be started.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ workflows: pf.catalog() }),
    },
    {
      name: 'workflow_start',
      description:
        'Start a run of a workflow, or re-attach to the run this key already names. Idempotent: ' +
        'calling it again for the same key returns the run in progress rather than starting a ' +
        'second one — this is how a nightly automation picks up where it left off. Returns the ' +
        'first work order.',
      inputSchema: {
        type: 'object',
        required: ['workflow', 'key'],
        properties: {
          workflow: str('string', 'workflow name from workflow_list'),
          key: str('string', 'stable key for this run (e.g. the date, the ticket id, the task id)'),
          input: { type: 'object', description: 'data for the start action' },
        },
      },
      handler: async ({ workflow, key, input }) => {
        const id = await pf.begin(workflow, key, input ?? {});
        return view(id, -1);
      },
    },
    {
      name: 'workflow_report',
      description:
        'Report the result of a work order and receive the next one. Set ok:false for an ' +
        'infrastructure failure (it will be retried). Set ok:false with permanent:true for a ' +
        'RESULT that is not a fault — the human denied it, the card declined — which advances ' +
        'the workflow down its failure branch instead of retrying.',
      inputSchema: {
        type: 'object',
        required: ['order_id'],
        properties: {
          order_id: str('string', 'order_id from the work order you fulfilled'),
          ok: { type: 'boolean', description: 'did the tool succeed (default true)' },
          result: { type: 'object', description: 'the tool result; its fields become the completion action data' },
          error: str('string', 'failure message when ok is false'),
          permanent: { type: 'boolean', description: 'true if this failure is a result, not a fault' },
        },
      },
      handler: async ({ order_id, ok = true, result = {}, error = '', permanent = false }) => {
        const order = pf.broker.orders.get(order_id);
        if (!order) return { error: `unknown order '${order_id}'` };
        const before = (await pf.view(order.instanceId)).seq;
        const ack = pf.report(order_id, { ok, result, error, permanent });
        if (!ack.ok) return { error: ack.reason, hint: ack.hint };
        return view(order.instanceId, before);
      },
    },
    {
      name: 'workflow_state',
      description: 'Current state and open work orders for a run, without changing anything.',
      inputSchema: {
        type: 'object',
        required: ['instance'],
        properties: { instance: str('string', 'instance id') },
      },
      handler: async ({ instance }) => view(instance),
    },
    {
      name: 'workflow_signal',
      description:
        'Send an event that did not come from a work order — an out-of-band cancel, or an ' +
        'approval that arrived through another surface. An action that does not apply in the ' +
        'current state is an observable reject, never an error.',
      inputSchema: {
        type: 'object',
        required: ['instance', 'action'],
        properties: {
          instance: str('string', 'instance id'),
          action: str('string', 'action name from the contract'),
          data: { type: 'object', description: 'action data' },
        },
      },
      handler: async ({ instance, action, data = {} }) => {
        const step = await pf.dispatch(instance, action, data);
        return { step_kind: step.stepKind, reason: step.rejectReason ?? null, ...(await view(instance)) };
      },
    },
    {
      name: 'workflow_journal',
      description:
        'The full journal of a run: every step, accepted or rejected, with its reason. This is ' +
        'also a valid Polygraph trace corpus — the run can be audited against the machine later.',
      inputSchema: {
        type: 'object',
        required: ['instance'],
        properties: { instance: str('string', 'instance id') },
      },
      handler: async ({ instance }) => ({
        journal: (await pf.journal(instance)).map((r) => ({
          seq: r.seq, action: r.action, step_kind: r.step_kind, reason: r.reject_reason ?? r.reason ?? null, post: r.post,
        })),
      }),
    },
  ];
}
