// State invariants for expense — what must hold in every state.
export const stateInvariants = [
  {
    // a run that ended without paying says why
    name: 'an-unpaid-ending-has-a-reason',
    pred: (s) => !['rejected', 'timed_out', 'failed', 'stopped'].includes(s.expenseState) || s.reason !== '',
  },
  {
    // a completed expense carries no failure reason
    name: 'a-paid-expense-has-no-failure-reason',
    pred: (s) => s.expenseState !== 'completed' || s.reason === '',
  },
  {
    // every state past idle knows which expense it is about (a run stopped
    // before it started never learned one)
    name: 'a-started-run-names-its-expense',
    pred: (s) => ['idle', 'stopped'].includes(s.expenseState) || s.expenseId !== '',
  },
];
