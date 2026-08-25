// The inversion that makes polyflow work for agents.
//
// In polyrun, the runtime executes effects itself via `handlers`. polyflow has
// no credentials, no connectors and no permission engine — the AGENT has all
// three. So every effect kind becomes a **work order** handed back to the agent:
// the handler parks, the agent claims the order, runs the tool with its own
// gates, and reports the result. Only then does the completion action dispatch.
//
// Durability falls out of polyrun's lease machinery: the pending map is
// in-memory, so a crash loses the promise, the lease expires, the effect is
// re-claimed and the order is re-offered. Nothing is lost, nothing double-runs
// (the completion dispatch is deduped by `${intentId}:done`).

const OPEN = 'open';

export class Broker {
  constructor({ heartbeatMs = 60_000 } = {}) {
    this.heartbeatMs = heartbeatMs;
    this.orders = new Map();   // orderId -> order record
    this.pending = new Map();  // orderId -> { resolve, reject, timer }
  }

  /** A polyrun handler for `kind` that parks instead of executing. */
  handler(kind, spec = {}) {
    return (payload, intentId, ctx) => new Promise((resolve, reject) => {
      const order = {
        orderId: intentId,
        instanceId: ctx.instanceId,
        seq: ctx.seq,
        attempt: ctx.attempt,
        kind,
        tool: spec.tool ?? kind,
        target: spec.target ?? null,
        why: spec.why ?? '',
        args: payload ?? {},
        status: OPEN,
        issuedAt: Date.now(),
      };
      this.orders.set(order.orderId, order);
      // The agent is the callback and may take turns, not milliseconds. polyrun
      // calls this the second-class escape hatch; for a human-in-the-loop tool
      // it is the honest one. Heartbeat until reported.
      const timer = setInterval(() => {
        ctx.extendLease(this.heartbeatMs * 2).catch(() => {});
      }, this.heartbeatMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(order.orderId, { resolve, reject, timer });
    });
  }

  /** Open work orders for one instance — what the agent must do next. */
  open(instanceId) {
    return [...this.orders.values()]
      .filter((o) => o.status === OPEN && o.instanceId === instanceId)
      .map(({ orderId, kind, tool, target, args, why, attempt }) =>
        ({ orderId, kind, tool, target, args, why, attempt }));
  }

  /**
   * The agent reports a tool result.
   *   ok:true              -> effect succeeded; onSuccess action dispatches
   *   ok:false             -> retryable failure (infrastructure)
   *   ok:false, permanent  -> a RESULT, not a fault (denied, declined) ->
   *                           onFailure action dispatches immediately
   */
  report(orderId, { ok = true, result = {}, error = '', permanent = false } = {}) {
    const order = this.orders.get(orderId);
    const waiter = this.pending.get(orderId);
    if (!order) return { ok: false, reason: 'unknown-order' };
    if (!waiter) {
      // Lease expired and the handler was re-entered, or the process restarted.
      return { ok: false, reason: 'order-expired', hint: 'call workflow_next again' };
    }
    clearInterval(waiter.timer);
    this.pending.delete(orderId);
    order.status = ok ? 'done' : 'failed';
    order.closedAt = Date.now();
    if (ok) waiter.resolve(result && typeof result === 'object' ? result : { value: result });
    else waiter.reject(Object.assign(new Error(error || 'tool failed'), { permanent }));
    return { ok: true };
  }

  /** Shutdown: fail every parked handler so the runtime's timers can drain.
   *  The effect rows stay inflight; a restart re-claims and re-offers them. */
  abort(reason = 'polyflow shutting down') {
    for (const [id, waiter] of this.pending) {
      clearInterval(waiter.timer);
      waiter.reject(new Error(reason));
      const order = this.orders.get(id);
      if (order) order.status = 'aborted';
    }
    this.pending.clear();
  }

  forget(instanceId) {
    for (const [id, o] of this.orders) if (o.instanceId === instanceId && o.status !== OPEN) this.orders.delete(id);
  }
}
