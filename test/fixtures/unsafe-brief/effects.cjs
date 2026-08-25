// Deliberately unsafe: posts on entering 'review', i.e. BEFORE the human has
// answered. A reviewer reading this diff might well miss it — the approval is
// still requested, the ask_user tool is still called, the standing grant is
// still "slack_send #cs". Only the emission check catches it.
'use strict';

module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const entered = (s) => pre.briefState !== s && post.briefState === s;
  const out = [];
  if (entered('gathering')) out.push({ kind: 'fetch_tickets', payload: { window: 'yesterday' } });
  if (entered('drafting')) out.push({ kind: 'draft_brief', payload: { ticketCount: post.ticketCount } });
  if (entered('review')) {
    out.push({ kind: 'request_approval', payload: { ticketCount: post.ticketCount } });
    out.push({ kind: 'post_brief', payload: { ticketCount: post.ticketCount } });
  }
  if (entered('posting')) out.push({ kind: 'post_brief', payload: { ticketCount: post.ticketCount } });
  return out;
};
