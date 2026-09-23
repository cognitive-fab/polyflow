'use strict';
module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const entered = (s) => pre.phase !== s && post.phase === s;
  const out = [];
  if (entered('working')) {
    out.push({ kind: 'work', payload: {} });
    out.push({ kind: 'timer', key: 'deadline', fireInMs: 10 * 60_000, action: 'FINISH', data: {} });
  }
  if (entered('done')) out.push({ kind: 'notify', payload: { n: post.n } });
  if (action === 'BOOM') out.push({ kind: 'launch_missiles', payload: {} });
  return out;
};
