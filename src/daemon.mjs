// The polyflow daemon — a polyrun runtime whose effect handlers are the agent.
//
// Startup is the admission gate: every workflow in the library is exhaustively
// emission-checked before it is registered. A workflow that fails, or whose
// exploration was bounded, is NOT registered — it cannot be started at all.
// Nothing runs here on the strength of "it worked once".

import { createRuntime } from './polyrun.mjs';
import { Library, deriveKey } from './library.mjs';
import { Broker } from './broker.mjs';
import { Area } from './areas.mjs';

export class Polyflow {
  constructor({
    workflowsDir = 'workflows',
    dbPath = '.polyflow/polyflow.sqlite',
    agent = 'default',
    instance = 'default',
    leaseMs = 5 * 60_000,
    pollMs = 100,
    // polycrew supplies a store-backed broker shared across processes; the
    // default one keeps its parked handlers in this process's memory.
    broker = new Broker(),
  } = {}) {
    this.area = new Area({ agent, instance });
    this.library = new Library(workflowsDir);
    this.broker = broker;
    this.dbPath = dbPath;
    this.leaseMs = leaseMs;
    this.pollMs = pollMs;
    this.certificates = new Map();
    this.rt = null;
  }

  async start() {
    this.library.load();
    const machines = [];
    const handlers = {};

    for (const wf of this.library.workflows.values()) {
      const cert = await this.library.certify(wf);
      this.certificates.set(wf.name, cert);
      if (!cert.ok) continue; // refused: not registered, cannot be started
      machines.push(this.library.machineSpec(wf));
      for (const [kind, spec] of Object.entries(wf.tools)) {
        handlers[kind] = this.broker.handler(kind, spec);
      }
    }

    this.rt = await createRuntime({
      store: { sqlite: this.dbPath },
      machines,
      handlers,
      worker: { leaseMs: this.leaseMs },
      poll: { effectPollMs: this.pollMs, timerPollMs: this.pollMs },
    });
    this.rt.startWorkers({ effectPollMs: this.pollMs, timerPollMs: this.pollMs });
    return this;
  }

  admitted(name) {
    const cert = this.certificates.get(name);
    return Boolean(cert && cert.ok);
  }

  catalog() {
    return this.library.list().map((w) => ({
      ...w,
      admitted: this.admitted(w.name),
      guarantees: this._guarantees(w.name),
    }));
  }

  // The invariant names are the sentences the user is actually approving.
  _guarantees(name) {
    return this.certificates.get(name)?.invariantNames ?? [];
  }

  /**
   * Start a run, or re-attach to the one this key already names.
   *
   * When the workflow declares a key policy the key is DERIVED from validated
   * input fields and whatever key the caller passed is ignored. That is what
   * stops an agent which finds a completed run from inventing a fresh key and
   * doing the job a second time (FINDINGS-phase3.md §6).
   */
  async begin(workflow, key, input = {}) {
    const wf = this.library.get(workflow);
    if (!wf) throw new Error(`unknown workflow '${workflow}'`);
    if (!this.admitted(workflow)) {
      const cert = this.certificates.get(workflow);
      throw new Error(
        `workflow '${workflow}' was refused by the admission gate and cannot be started:\n${cert?.report ?? 'no certificate'}`
      );
    }
    let note;
    if (wf.key) {
      const derived = deriveKey(wf.key, input);
      if (key && key !== derived) {
        note = `key '${key}' ignored: this workflow's runs are identified by ` +
               `${wf.key.template} = '${derived}', derived from the input you gave.`;
      }
      key = derived;
    } else if (!key) {
      throw Object.assign(new Error(`workflow '${workflow}' needs a key`), { expected: true });
    }
    const instanceId = this.area.instanceId(workflow, key);
    await this.rt.create(workflow, instanceId, { action: wf.inputAction, data: input });
    return { instanceId, key, note };
  }

  /** State + open work orders. The agent's only view of the run. */
  async view(instanceId) {
    const { state, status, seq, machineId } = await this.rt.getState(instanceId);
    const orders = this.broker.open(instanceId);
    return {
      instanceId, workflow: machineId, status, seq, state,
      orders,
      // 'active' is polyrun's live status; anything else (terminal, poisoned)
      // means the run is over regardless of what the state tree says.
      done: status !== 'active' || this._isTerminal(machineId, state),
      key: Area.parse(instanceId).key,
    };
  }

  _isTerminal(machineId, state) {
    const wf = this.library.get(machineId);
    if (!wf || !wf.terminal) return false;
    return wf.terminal.values.has(state[wf.terminal.key]);
  }

  report(orderId, payload) { return this.broker.report(orderId, payload); }

  /**
   * Wait for the run to come to rest after a report: the completion action is
   * dispatched by the worker loop, so the next work order appears a tick later.
   * Returns as soon as the journal advances past `sinceSeq` AND either an order
   * is open or the instance is terminal.
   */
  async settle(instanceId, { sinceSeq = -1, timeoutMs = 5000, stepMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let view = await this.view(instanceId);
    while (Date.now() < deadline) {
      if (view.seq > sinceSeq && (view.orders.length > 0 || view.done)) return view;
      await new Promise((r) => setTimeout(r, stepMs));
      view = await this.view(instanceId);
    }
    return { ...view, settled: false };
  }

  /** An event that did not come from a work order (an out-of-band signal). */
  dispatch(instanceId, action, data = {}, actionId) {
    return this.rt.dispatch(instanceId, action, data, actionId);
  }

  journal(instanceId) { return this.rt.getJournal(instanceId); }
  traces(instanceId) { return this.rt.exportTraces(instanceId); }

  /** Clean shutdown. A real crash skips all of this — the lease is what makes
   *  either path recoverable, so `drainMs` only reduces log noise. */
  async close({ drainMs = 50 } = {}) {
    if (!this.rt) return;
    this.broker.abort();
    if (drainMs) await new Promise((r) => setTimeout(r, drainMs));
    await this.rt.stopWorkers();
    await this.rt.close?.();
  }
}
