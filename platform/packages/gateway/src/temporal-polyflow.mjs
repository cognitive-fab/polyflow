// The Polyflow surface, over governed runs on a Temporal namespace — FR-AGT.3;
// technical spec §8.
//
// polyflow's MCP tools (`makeTools` in the root package) drive an object with
// this surface: catalog, begin, view, settle, report, dispatch, journal, and a
// broker that can say which run an order belongs to. The root package
// implements it over an in-process polyrun; this implements it over Temporal,
// so the six tools — unchanged — become a way for any MCP-capable agent to be
// a participant in a governed Temporal run.
//
// Every write goes through a workflow Update, so the workflow stays the single
// source of truth. Orders are reported, not executed here: a governed run
// started through the gateway runs in `external` mode, where each work order
// waits for a report instead of scheduling an activity.
//
// The gateway holds a Temporal client for the whole namespace, and its tool
// arguments come from a model. So it acts only on runs of the machines it
// offers (P9 security review SEC-GW1): an instance id must be the id
// `workflowIdFor(machine, key)` gives one of them, and the run must say it is
// that machine. Anything else is refused before a handle is touched.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowUpdateFailedError, WorkflowNotFoundError } from '@temporalio/client';
import { startGoverned, loadMachineDir, checkMachineDir, workflowIdFor, signPrincipal } from '@cognitive-fab/polyflow-temporal';
import { digest } from '@cognitive-fab/polyflow-kernel';

const errText = (err) => `${err?.cause?.message ?? err?.message ?? err}`;
/** An error the model should see as it is: about its request, not the infrastructure. */
const expected = (message) => Object.assign(new Error(message), { expected: true });

export class TemporalPolyflow {
  /**
   * @param {object} o
   * @param {import('@temporalio/client').Client} o.client
   * @param {string} o.taskQueue      where the governed workers poll
   * @param {Record<string,string>} o.machines   name -> machine directory (the same ones the workers bundle)
   * @param {object} [o.trust]        trust store: only certified machines are admitted
   * @param {boolean} [o.allowUncertified]  development: without a trust store, machines may be started,
   *                                  and the catalogue says they are uncertified (`admitted: false, uncertified: true`)
   * @param {{id:string, roles?:string[]}} [o.actor]  who this gateway speaks for — from its own configuration, never from a tool argument
   * @param {{keyId:string, privateKeyPem:string}} [o.principalKey]  with an actor: sign it, per action, so the
   *                                  workflow can verify it (P9 security SEC-PR1). Without one the actor is sent
   *                                  as a claim, and the workflow records it as unverified.
   * @param {string} [o.audience]     the namespace a signed actor acts in (default: the client's)
   * @param {number} [o.principalTtlMs]
   */
  constructor({ client, taskQueue, machines, trust = null, allowUncertified = false, actor = null, principalKey = null, audience = null, principalTtlMs = 60_000 }) {
    this.client = client;
    this.taskQueue = taskQueue;
    this.actor = actor;
    this.signer = actor && principalKey ? { key: principalKey, aud: audience ?? client?.options?.namespace ?? null, ttlMs: principalTtlMs } : null;
    this.machines = new Map();
    for (const [name, dir] of Object.entries(machines)) {
      const m = loadMachineDir(dir);
      if (m.descriptor.name !== name) throw new Error(`machine directory ${m.dir} calls itself '${m.descriptor.name}', offered as '${name}'`);
      let certificate = null;
      // Fail closed (SEC-GW2): no trust store means nothing is admitted.
      let admitted = false;
      let uncertified = false;
      let refusal = 'the gateway has no trust store (POLYFLOW_TRUST), so no certificate can be checked';
      if (trust) {
        try { certificate = checkMachineDir(m.dir, trust); admitted = true; refusal = null; } catch (err) { refusal = err.message; }
      } else if (allowUncertified) {
        uncertified = true;
        refusal = null;
      }
      const inv = join(m.dir, 'effect-invariants.mjs');
      this.machines.set(name, { ...m, certificate, admitted, uncertified, refusal, hasInvariants: existsSync(inv) });
    }
    this.orderRuns = new Map(); // orderId -> workflowId, learned from every view
    // makeTools asks the broker which run an order belongs to.
    this.broker = { orderById: (orderId) => (this.orderRuns.has(orderId) ? { orderId, instanceId: this.orderRuns.get(orderId) } : undefined) };
  }

  /** The actor to send with one action: signed for exactly that action when the gateway holds a key. */
  actorFor(act) {
    if (!this.signer) return this.actor;
    const { key, aud, ttlMs } = this.signer;
    return signPrincipal({ id: this.actor.id, roles: this.actor.roles ?? [], ...(aud ? { aud } : {}), act }, key, { ttlMs });
  }

  catalog() {
    return [...this.machines.values()].map((m) => ({
      name: m.descriptor.name,
      description: m.descriptor.description,
      area: 'temporal',
      admitted: m.admitted,
      ...(m.uncertified ? { uncertified: true } : {}),
      guarantees: m.certificate?.guarantees ?? [],
      tools: Object.entries(m.descriptor.tools ?? {}).map(([kind, t]) => `${kind} -> ${t.tool ?? kind}`),
      key: m.descriptor.key ? { template: m.descriptor.key.template, derived_from: Object.keys(m.descriptor.key.fields ?? {}) } : null,
    }));
  }

  /**
   * The machine an instance id belongs to, if it is a run this gateway may
   * touch: exactly `workflowIdFor(machine, key)` for an offered machine.
   * Throws (expected) otherwise.
   */
  machineOf(instanceId) {
    const parts = typeof instanceId === 'string' ? instanceId.split('/') : [];
    let name = null;
    let key = null;
    try {
      if (parts.length === 3 && parts[0] === 'polyflow') { name = decodeURIComponent(parts[1]); key = decodeURIComponent(parts[2]); }
    } catch { /* a malformed escape is not an instance id */ }
    if (name === null || !this.machines.has(name) || workflowIdFor(name, key) !== instanceId) {
      throw expected(`'${String(instanceId).slice(0, 200)}' is not a run of a workflow this gateway offers (see workflow_list)`);
    }
    return { name, key };
  }

  async begin(workflow, key, input = {}) {
    const m = this.machines.get(workflow);
    if (!m) throw expected(`unknown workflow '${workflow}'`);
    if (!m.admitted && !m.uncertified) throw expected(`workflow '${workflow}' is not admitted: ${m.refusal}`);
    const r = await startGoverned(this.client, {
      descriptor: m.descriptor, input, taskQueue: this.taskQueue, key: key ?? undefined,
      // The gateway's runs wait for reported orders rather than scheduling activities.
      mode: 'external',
    });
    return { instanceId: r.workflowId, key: r.key, note: r.note, status: r.status };
  }

  async view(instanceId) {
    const { name, key } = this.machineOf(instanceId);
    const h = this.client.workflow.getHandle(instanceId);
    let s;
    try {
      s = await h.query('polyflow.state');
    } catch (err) {
      // A closed run answers queries only while a worker holds its history;
      // its result is the final state — but only a GovernedWorkflow's result
      // (SEC-GW1): the id alone does not say what ran under it.
      let desc;
      try { desc = await h.describe(); } catch (e) {
        if (e instanceof WorkflowNotFoundError) throw expected(`unknown instance '${instanceId}'`);
        throw e;
      }
      if (desc.type !== 'GovernedWorkflow') throw expected(`'${instanceId}' is not a governed run`);
      if (desc.status.name === 'RUNNING') throw err;
      const result = await h.result().catch(() => null);
      if (result && result.machine !== name) throw expected(`'${instanceId}' is not a run of '${name}'`);
      return { instanceId, workflow: name, status: desc.status.name.toLowerCase(), seq: result?.seq ?? 0, state: result?.state ?? {}, orders: [], done: true, key };
    }
    if (s?.machine !== name) throw expected(`'${instanceId}' is not a run of '${name}'`);
    for (const o of s.orders) this.orderRuns.set(o.orderId, instanceId);
    return {
      instanceId,
      workflow: s.machine,
      status: s.terminal ? 'terminal' : s.poisoned ? 'poisoned' : 'active',
      seq: s.seq,
      state: s.state,
      orders: s.orders.map((o) => ({
        orderId: o.orderId, kind: o.kind, tool: o.tool, target: o.target, args: o.args, why: o.why,
        attempt: o.attempt ?? 1, role: o.role, claimedBy: o.claimedBy, claimedUntil: o.claimedUntil,
      })),
      done: s.terminal,
      key,
    };
  }

  /** Wait for a step to land: the same contract as the root Polyflow.settle. */
  async settle(instanceId, { sinceSeq = -1, actionId = null, timeoutMs = 10_000, stepMs = 50 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let v = await this.view(instanceId);
    const landed = async () => {
      if (!actionId || v.done) return true;
      const j = await this.client.workflow.getHandle(instanceId).query('polyflow.journal').catch(() => []);
      return j.some((row) => row.actionId === actionId);
    };
    while (Date.now() < deadline) {
      if ((v.seq > sinceSeq && (v.orders.length > 0 || v.done) && await landed()) || v.done) return v;
      await new Promise((r) => setTimeout(r, stepMs));
      v = await this.view(instanceId);
    }
    return { ...v, settled: false };
  }

  /** A report against an order: `ok`, `result`, or a failure that is permanent or retryable. */
  async report(orderId, { ok = true, result = {}, error = '', permanent = false } = {}) {
    const instanceId = this.orderRuns.get(orderId);
    if (!instanceId) return { ok: false, reason: 'unknown-order', hint: 'call workflow_state for the run first' };
    try {
      const h = this.client.workflow.getHandle(instanceId);
      // A signed report names the order's current attempt and the outcome it reports (P9 review PR1).
      const attempt = this.signer ? (await h.query('polyflow.state')).orders.find((o) => o.orderId === orderId)?.attempt : undefined;
      const r = await h.executeUpdate('polyflow.report', {
        // No updateId: a second report of a closed order must be REFUSED by the
        // workflow ("not open"), not silently answered from Temporal's dedupe.
        args: [{ orderId, ok, result, error, permanent, actor: this.actorFor({ op: 'report', wf: instanceId, ref: orderId, attempt, digest: digest({ ok, result, error, permanent }) }) }],
      });
      return { ok: true, ...r };
    } catch (err) {
      if (err instanceof WorkflowUpdateFailedError) return { ok: false, reason: errText(err) };
      throw err;
    }
  }

  /** An out-of-band action: an observable reject, never an error. */
  async dispatch(instanceId, action, data = {}, actionId) {
    // Checked before the Update: the run must be one this gateway offers, and say so.
    await this.view(instanceId);
    try {
      const r = await this.client.workflow.getHandle(instanceId).executeUpdate('polyflow.propose', {
        args: [{ action, data, ...(actionId ? { actionId } : {}), actor: this.actorFor({ op: 'propose', wf: instanceId, ref: action, digest: digest(data) }) }],
      });
      return { stepKind: r.stepKind, seq: r.seq, rejectReason: r.reason };
    } catch (err) {
      if (err instanceof WorkflowUpdateFailedError) return { stepKind: 'rejected', seq: null, rejectReason: errText(err) };
      throw err;
    }
  }

  async journal(instanceId) {
    await this.view(instanceId);
    const rows = await this.client.workflow.getHandle(instanceId).query('polyflow.journal');
    return rows.map((r) => ({ seq: r.seq, action: r.action, action_id: r.actionId, step_kind: r.stepKind, reject_reason: r.rejectReason, post: r.post }));
  }

  /** Claim an order for this gateway's actor (polycrew's protocol, as a workflow Update). */
  async claim(orderId) {
    const instanceId = this.orderRuns.get(orderId);
    if (!instanceId) return { claimed: false, reason: 'unknown-order' };
    try {
      return await this.client.workflow.getHandle(instanceId).executeUpdate('polyflow.claim', { args: [{ orderId, actor: this.actorFor({ op: 'claim', wf: instanceId, ref: orderId }) }] });
    } catch (err) {
      if (err instanceof WorkflowUpdateFailedError) return { claimed: false, reason: errText(err) };
      throw err;
    }
  }
}

/** The package version, for the MCP server's serverInfo. */
export const version = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version;
