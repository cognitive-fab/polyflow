// An agent-shaped workflow that authors a plan at run time and asks whether it
// may run it — the "plans as proposals" move (FR-PLAN).
import { proposePlan } from '@cognitive-fab/polyflow-temporal/workflows';

export * from '@cognitive-fab/polyflow-temporal/workflows';

export async function planningAgent({ plans }) {
  const outcomes = [];
  for (const plan of plans) {
    const r = await proposePlan(plan);
    outcomes.push({ verdict: r.verdict, witness: r.witness ?? null, escalations: r.escalations, results: r.results ?? null });
    if (r.verdict === 'admitted') break; // the agent re-planned until a plan was admitted
  }
  return outcomes;
}
