// Effect mapper — pure, edge-triggered on state transitions. No I/O, no clock,
// no randomness. An effect is a WORK ORDER: the activity of the same name
// performs it, or a person does (request_approval).
'use strict';

// Upstream's default: the workflow waits 10 seconds for the signal. Here the
// window is part of the certified machine; the timer's action is a terminal
// state with no payment on its path.
const APPROVAL_WINDOW_MS = 10 * 1000;

module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const entered = (s) => pre.expenseState !== s && post.expenseState === s;
  const out = [];

  if (entered('creating')) {
    out.push({ kind: 'createExpense', payload: { id: post.expenseId } });
  }
  if (entered('pending_approval')) {
    out.push({ kind: 'request_approval', payload: { id: post.expenseId } });
    out.push({ kind: 'timer', key: 'approvalWindow', fireInMs: APPROVAL_WINDOW_MS, action: 'APPROVAL_TIMEOUT', data: {} });
  }
  if (entered('paying')) {
    out.push({ kind: 'payment', payload: { id: post.expenseId } });
  }
  return out;
};
