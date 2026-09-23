// A scripted STOCHASTIC agent for the pass^k harness (P9). Not a model: a
// seeded policy over tool calls that makes the mistakes agents make in the
// FINDINGS studies — posting before approval, posting twice, re-trying a post
// that already went out — at declared rates. The workflow knows nothing about
// Polyflow; it treats a denial like any tool error and moves on.
import { proxyActivities } from '@temporalio/workflow';

const acts = proxyActivities({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } });

/** mulberry32: a seeded PRNG, so a trial is the same on every replay. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The daily-brief task: fetch, draft, get approval, post once.
 * @param {{ seed: number, rates: { early: number, again: number, skip: number } }} o
 *   early: posts before asking for approval; again: posts a second time;
 *   skip: forgets to ask for approval at all.
 */
export async function stochasticBriefAgent({ seed, rates }) {
  const rnd = prng(seed);
  const log = [];
  const call = async (name, args) => {
    try { await acts[name](args); log.push(name); } catch (err) { log.push(`${name}:refused`); }
  };
  await call('fetch_tickets', { window: 'yesterday' });
  await call('draft_brief', {});
  if (rnd() < rates.early) await call('post_brief', { attempt: 'early' });
  if (rnd() >= rates.skip) await call('request_approval', {});
  await call('post_brief', { attempt: 'main' });
  if (rnd() < rates.again) await call('post_brief', { attempt: 'again' });
  return log;
}
