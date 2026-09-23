// Activities for PolyflowGateWorkflow — the I/O half of the version gate.
import { digest, admitPolicy, vetPolicyChange } from '@cognitive-fab/polyflow-kernel';
import { vet } from './vet.mjs';

/**
 * @param {import('@temporalio/client').Client} client  a client for the namespace the fleet runs in
 */
/**
 * @param {object} [o]
 * @param {(act: object) => object} [o.signer]  mints an action-bound principal token for the gate's
 *   own Updates and Signals, when the workers require verified principals (P9 security SEC-MG1)
 */
export function gateActivities(client, { trust = null, allowUncertified = false, signer = null } = {}) {
  const principal = (act) => (signer ? { principal: signer(act) } : {});
  return {
    /** Every running governed run of a machine, with its machine state (read by Query). */
    async 'polyflow.gate.fleet'({ machine, fromBuildId = null }) {
      const prefix = `polyflow/${encodeURIComponent(machine)}/`;
      const out = [];
      for await (const w of client.workflow.list({ query: "WorkflowType = 'GovernedWorkflow' AND ExecutionStatus = 'Running'" })) {
        if (!w.workflowId.startsWith(prefix)) continue;
        const s = await client.workflow.getHandle(w.workflowId).query('polyflow.state');
        if (s.machine !== machine || s.terminal) continue;
        const buildId = s.certificate?.buildId ?? s.certificate ?? null;
        // Only the runs on the version being replaced (P4/P5 review VG3).
        if (fromBuildId && buildId !== fromBuildId) continue;
        out.push({ workflowId: w.workflowId, state: s.state, certificate: buildId, openKinds: (s.orders ?? []).map((o) => o.kind) });
      }
      return out;
    },

    /** polyvers over each distinct state. The per-state reports stay here; the workflow gets the decisions. */
    async 'polyflow.gate.vet'({ oldDir, newDir, fleet, allowEmptyFleet }) {
      const { reports, ...rest } = vet({ oldDir, newDir, fleet, allowEmptyFleet, trust, allowUncertified });
      return rest;
    },

    /** Carry out the decisions on the runs themselves. */
    //
    // With Worker Versioning (`onVersionChange`), a run that moves is told so
    // BEFORE promotion and waits; it continues as new onto the new version once
    // that version is current and the run is woken (Upgrade-on-Continue-as-New).
    // Without it, a moving run hands over at once. Each decision carries the
    // digest of the state it was computed from: a run that moved on since
    // refuses it (review MG2), and is counted as stale, not as moved.
    async 'polyflow.gate.apply'({ decisions, toBuildId, onVersionChange = false }) {
      const done = { migrated: 0, upgrading: 0, recorded: 0, stale: [] };
      for (const d of decisions) {
        const h = client.workflow.getHandle(d.workflowId);
        if (d.decision === 'migrate' || (d.decision === 'auto-upgrade' && onVersionChange)) {
          try {
            const from = digest(d.from);
            const snapshot = d.to ?? d.from;
            const run = signer ? (await h.describe()).runId : undefined;
            await h.executeUpdate('polyflow.migrate', { args: [{ snapshot, from, toBuildId, onVersionChange, shapeChange: d.decision === 'migrate' && Boolean(d.to), ...principal({ op: 'migrate', wf: d.workflowId, ref: from, run, to: digest(snapshot) }) }] });
            if (d.decision === 'migrate') done.migrated++; else done.upgrading++;
          } catch (err) {
            done.stale.push({ workflowId: d.workflowId, reason: err?.cause?.message ?? err?.message });
          }
        } else {
          await h.signal('polyflow.version', { decision: d.decision, toBuildId, ...principal({ op: 'version', wf: d.workflowId }) });
          done.recorded++;
        }
      }
      return done;
    },

    /**
     * The policy ramp gate (P4.6): every running workflow the visibility query
     * names that runs under `oldPolicy`, vetted against `newPolicy` from its
     * own guard state.
     */
    async 'polyflow.gate.policy'({ oldPolicy, newPolicy, query, allowEmptyFleet = false }) {
      // As a guard-level worker enforces them: an omitted `unlabelled` is 'deny' (SEC-UL1).
      const asEnforced = (p) => admitPolicy(p.unlabelled === undefined ? { ...p, unlabelled: 'deny' } : p);
      const before = asEnforced(oldPolicy);
      const after = asEnforced(newPolicy);
      const fleet = [];
      const unread = [];
      const other = [];
      if (query != null && (typeof query !== 'string' || /;|--/.test(query) || query.length > 1000)) throw new Error('the fleet query is one visibility filter expression');
      for await (const w of client.workflow.list({ query: `ExecutionStatus = 'Running'${query ? ` AND (${query})` : ''}` })) {
        let g;
        try {
          g = await client.workflow.getHandle(w.workflowId, w.runId).query('polyflow.guard');
        } catch (err) {
          // A run whose guard cannot be read is not vetted, so it is not a pass:
          // this is also what a run looks like while its workers roll (P9 review GF1).
          unread.push({ workflowId: w.workflowId, reason: String(err?.message ?? err).slice(0, 200) });
          continue;
        }
        if (!g?.guard) continue; // a workflow without a guard (level observe, or no plugin)
        if (g.policy !== before.digest) { other.push(w.workflowId); continue; }
        fleet.push({ workflowId: w.workflowId, guard: g.guard, at: g.at });
      }
      const r = vetPolicyChange(before, after, fleet, { allowEmptyFleet });
      // Runs under another policy digest are named, not silently dropped (GF2).
      return { ...r, ok: r.ok && unread.length === 0, unread, otherPolicy: other, ...(unread.length ? { refused: `${unread.length} run(s) could not be read: ${unread.map((u) => u.workflowId).join(', ')}` } : {}) };
    },

    /** After promotion: wake every run waiting to move, so it sees the new current version. */
    async 'polyflow.gate.wake'({ machine }) {
      const prefix = `polyflow/${encodeURIComponent(machine)}/`;
      let woken = 0;
      for await (const w of client.workflow.list({ query: "WorkflowType = 'GovernedWorkflow' AND ExecutionStatus = 'Running'" })) {
        if (!w.workflowId.startsWith(prefix)) continue;
        const h = client.workflow.getHandle(w.workflowId);
        const s = await h.query('polyflow.state');
        if (!s.migrationPending?.onVersionChange) continue;
        await h.signal('polyflow.wake');
        woken++;
      }
      return { woken };
    },
  };
}
