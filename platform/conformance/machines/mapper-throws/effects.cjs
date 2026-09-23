// Conformance fixture (P9 review QJ3): a copy of examples/customer-brief with one change.
// Effect mapper — pure, edge-triggered on state transitions. No I/O, no clock,
// no randomness. In polyflow an "effect" is a WORK ORDER for the agent: the
// runtime never executes it, it hands it back through workflow_next and waits
// for workflow_report.
'use strict';

// The human has a working day to answer. A stale expiry rejects observably.
const APPROVAL_WINDOW_MS = 8 * 60 * 60 * 1000;

module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const entered = (s) => pre.briefState !== s && post.briefState === s;
  const out = [];

  if (entered('gathering')) {
    if (data && data.fail) throw new Error('ticket feed interrupted');
    out.push({ kind: 'fetch_tickets', payload: { window: 'yesterday' } });
  }
  if (entered('drafting')) {
    if (post.ticketCount === 3) throw new RangeError('out of memory while drafting');
    out.push({ kind: 'draft_brief', payload: { ticketCount: post.ticketCount } });
  }
  if (entered('review')) {
    throw new Error('stack overflow in the reviewer');
    out.push({ kind: 'request_approval', payload: { ticketCount: post.ticketCount } });
    out.push({ kind: 'timer', key: 'approvalWindow', fireInMs: APPROVAL_WINDOW_MS, action: 'DENIED', data: { reason: 'not-ready' } });
  }
  if (entered('posting')) {
    out.push({ kind: 'post_brief', payload: { ticketCount: post.ticketCount } });
  }
  return out;
};
