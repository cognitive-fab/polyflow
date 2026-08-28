// Effect mapper — pure, edge-triggered on state transitions. In polyflow an
// "effect" is a WORK ORDER for the agent: the runtime never executes it.
//
// The order here is the whole proposal. Verification is emitted on START, and
// staging is emitted only by the transition a PASSING verification causes —
// which is what makes 'no-push-without-a-passing-verify' true by construction
// rather than by good intentions.
'use strict';

module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const entered = (s) => pre.phase !== s && post.phase === s;
  const out = [];

  if (entered('verifying')) out.push({ kind: 'verify', payload: {} });
  if (entered('staging')) out.push({ kind: 'stage', payload: {} });
  if (entered('committing')) out.push({ kind: 'commit', payload: {} });
  if (entered('pushing')) out.push({ kind: 'push', payload: {} });
  return out;
};
