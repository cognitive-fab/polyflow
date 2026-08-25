// The workflow library — polyflow's procedural memory.
//
// A workflow is a directory holding the five artifacts polyrun needs plus a
// manifest that maps each effect kind to the AGENT tool that fulfils it:
//
//   polyflow.workflow.json   name, description, area, tools{kind -> {tool,target,why}}
//   contract.json            states, actions, finite data domain
//   machine.cjs              SAM v2 strict-profile module
//   effects.cjs              pure mapper: transition -> effect intents
//   effects.manifest.json    per-kind completion actions + retry policy
//   effect-invariants.mjs    what the machine o mapper may EMIT, on every path
//
// Nothing enters the library on the strength of "it worked once". `publish`
// runs the exhaustive emission check first and refuses on any violation.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkEffects, renderReport } from './polyrun.mjs';

const DESCRIPTOR = 'polyflow.workflow.json';

export class Library {
  constructor(dir) {
    this.dir = resolve(dir);
    this.workflows = new Map();
  }

  load() {
    this.workflows.clear();
    if (!existsSync(this.dir)) return this;
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name);
      if (!statSync(path).isDirectory()) continue;
      if (!existsSync(join(path, DESCRIPTOR))) continue;
      this.workflows.set(name, this._read(name, path));
    }
    return this;
  }

  _read(name, path) {
    const d = JSON.parse(readFileSync(join(path, DESCRIPTOR), 'utf-8'));
    const file = (k, dflt) => resolve(path, d[k] ?? dflt);
    const contract = JSON.parse(readFileSync(file('contract', 'contract.json'), 'utf-8'));
    const terminalKey = contract.terminalKey
      ?? (contract.stateKeys && contract.stateKeys[0] && contract.stateKeys[0].name);
    return {
      terminal: { key: terminalKey, values: new Set(contract.terminalStates ?? []) },
      name: d.name ?? name,
      dir: path,
      description: d.description ?? '',
      area: d.area ?? 'default',
      tools: d.tools ?? {},
      inputAction: d.inputAction ?? 'START',
      contract: file('contract', 'contract.json'),
      module: file('machine', 'machine.cjs'),
      mapper: file('effects', 'effects.cjs'),
      manifest: file('manifest', 'effects.manifest.json'),
      effectInvariants: file('effectInvariants', 'effect-invariants.mjs'),
      invariants: existsSync(file('invariants', 'invariants.mjs'))
        ? file('invariants', 'invariants.mjs') : undefined,
      certified: d.certified ?? null,
    };
  }

  get(name) { return this.workflows.get(name); }
  list() {
    return [...this.workflows.values()].map((w) => ({
      name: w.name, description: w.description, area: w.area,
      tools: Object.entries(w.tools).map(([kind, t]) => `${kind} -> ${t.tool}`),
      certified: w.certified,
    }));
  }

  /**
   * The admission gate. Exhaustively enumerates every reachable emission path
   * over the contract's declared domain and checks the effect invariants.
   * Returns {ok, report, summary}; a caller must not register on ok:false.
   */
  async certify(wf, { maxDepth = 12, maxPaths = 50_000 } = {}) {
    const invMod = await import(pathToFileURL(wf.effectInvariants).href);
    const invariantNames = (invMod.effectInvariants ?? []).map((i) => i.name);
    const result = await checkEffects({
      module: wf.module, mapper: wf.mapper, manifest: wf.manifest,
      invariants: wf.effectInvariants, contract: wf.contract, maxDepth, maxPaths,
    });
    const violations = result.violations ?? [];
    // A bounded run is not a pass — polyrun's doctrine, kept here: a workflow
    // whose exploration hit the depth/path ceiling is not admitted.
    const bounded = Boolean(result.bounded);
    return {
      ok: violations.length === 0 && !bounded,
      bounded,
      violations,
      invariantNames,
      pathsExplored: result.pathsExplored,
      statesSeen: result.statesSeen,
      notes: result.notes ?? [],
      report: renderReport(result),
    };
  }

  /** polyrun `machines` entry for a certified workflow. */
  machineSpec(wf) {
    return {
      machineId: wf.name,
      module: wf.module,
      contract: wf.contract,
      effects: { mapper: wf.mapper, manifest: wf.manifest },
      ...(wf.invariants ? { invariants: wf.invariants } : {}),
      effectInvariants: wf.effectInvariants,
    };
  }
}
