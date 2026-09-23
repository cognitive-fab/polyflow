// Effect mapper — pure. The judge reads the message; a person reviews what the
// judge could not clear; a refund is paid only from `refunding`.
'use strict';

const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const entered = (s) => pre.phase !== s && post.phase === s;
  const out = [];
  if (entered('assessing')) out.push({ kind: 'assess', payload: { battery: 'refund', state: { message: post.message } } });
  if (entered('reviewing')) {
    out.push({ kind: 'review', payload: { message: post.message } });
    out.push({ kind: 'timer', key: 'reviewWindow', fireInMs: REVIEW_WINDOW_MS, action: 'DECLINED', data: { reason: 'not-eligible' } });
  }
  if (entered('refunding')) out.push({ kind: 'refund', payload: { route: post.route } });
  return out;
};
