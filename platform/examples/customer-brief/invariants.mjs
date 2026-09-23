// State invariants for customer-brief — what must hold in every state, in the
// Polygraph invariants format. The effect invariants say what may be EMITTED;
// these say what a state may BE, which is what polyvers checks live runs against.
export const stateInvariants = [
  {
    // a run that ended without posting says why
    name: 'an-unposted-ending-has-a-reason',
    pred: (s) => !['denied', 'failed', 'cancelled', 'stopped'].includes(s.briefState) || s.reason !== '',
  },
  {
    // nothing is drafted, reviewed or posted from zero tickets
    name: 'no-work-on-an-empty-brief',
    pred: (s) => !['drafting', 'review', 'posting', 'posted'].includes(s.briefState) || s.ticketCount > 0,
  },
  {
    // a run that posted carries no failure reason
    name: 'a-posted-brief-has-no-failure-reason',
    pred: (s) => s.briefState !== 'posted' || s.reason === '',
  },
];
