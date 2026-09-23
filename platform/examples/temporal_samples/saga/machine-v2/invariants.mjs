// State invariants for saga — what must hold in every state.
export const stateInvariants = [
  {
    // a run that ended without opening says why
    name: 'an-unopened-ending-has-a-reason',
    pred: (s) => !['compensated', 'compensation_failed', 'failed', 'stopped'].includes(s.phase) || s.reason !== '',
  },
  {
    // an opened account carries no failure
    name: 'an-opened-account-has-no-failure',
    pred: (s) => s.phase !== 'opened' || (s.reason === '' && s.failedStep === ''),
  },
  {
    // compensating, or having compensated, names the step that failed
    name: 'compensation-names-the-failed-step',
    pred: (s) => !['undo_bank', 'undo_client', 'undo_address', 'compensated', 'compensation_failed'].includes(s.phase) || s.failedStep !== '',
  },
  {
    // every state past idle knows which account it is about
    name: 'a-started-run-names-its-account',
    pred: (s) => ['idle', 'stopped'].includes(s.phase) || typeof s.params.accountId === 'string',
  },
];
