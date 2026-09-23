// An ordinary agent-loop workflow, written the way a Temporal customer writes
// one — nothing in it knows Polyflow exists. The plugin is the only change.
import { proxyActivities, continueAsNew } from '@temporalio/workflow';

const acts = proxyActivities({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } });

export async function agentLoop({ steps = 3, failAt = -1 } = {}) {
  const trail = [];
  for (let i = 0; i < steps; i++) {
    const thought = await acts.think({ i });
    trail.push(thought);
    if (i === failAt) {
      try { await acts.flaky({ i }); } catch { trail.push('flaky-failed'); }
    } else {
      trail.push(await acts.search({ q: 'step ' + i }));
    }
  }
  trail.push(await acts.post({ text: trail.join(' | ') }));
  return trail;
}

export async function longAgent({ rounds = 2, done = 0 } = {}) {
  await acts.think({ i: done });
  if (done + 1 < rounds) await continueAsNew({ rounds, done: done + 1 });
  return await acts.post({ text: 'finished after ' + rounds });
}
