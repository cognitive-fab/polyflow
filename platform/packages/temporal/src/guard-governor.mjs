// Chooses the per-run governor for the configured level. Runs in the isolate.
//
// observe (G0): record everything, allow everything.
// guard   (G1): the rule kernel decides every effect from the run's own history
//               and the pinned policy. Pure, so it replays: the verdict a run
//               got the first time is the verdict it gets on every replay.

import { createGuard, classify, routeTarget } from '@cognitive-fab/polyflow-kernel';
import { observeOnly } from './workflow-interceptors.mjs';

export function guardGovernor(config) {
  const policy = config.policy;
  const guard = createGuard(policy);
  let state = guard.init();
  return {
    level: 'guard',
    policy,
    admission: () => ({ level: 'guard', policy: { name: policy.policy, version: policy.version, digest: policy.digest } }),
    // A routed activity (one activity, many tools) is classified by the tool it carries.
    classify: (target, input) => {
      const routed = routeTarget(policy, target, input?.args);
      return { ...classify(policy, routed), ...(routed !== target ? { route: routed } : {}) };
    },
    decide: (c) => guard.decide(state, c),
    commit: (c, d) => { state = guard.commit(state, c, d); },
    observe: (o) => { if (o.type === 'observation') state = guard.observe(state, o); },
    signal: (name, at) => { state = guard.signal(state, name, at); },
    grant: (approval) => { state = guard.grant(state, approval); },
    voidApproval: (id) => { state = guard.voidApproval(state, id); },
    state: () => state,
    // Continue-as-New hands the guard's state to the next run (P4/P5 review GC):
    // budgets, taint and rate windows are the chain's, not one execution's.
    restore: (carried) => { state = carried; },
  };
}

export function governorFor(config) {
  if (config.level === 'observe') return observeOnly(config);
  if (config.level === 'guard') return guardGovernor(config);
  throw new Error(`level '${config.level}' is not available in this build`);
}
