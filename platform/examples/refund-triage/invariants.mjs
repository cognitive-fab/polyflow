export const stateInvariants = [
  { name: 'a-refund-names-who-cleared-it', pred: (s) => !['refunding', 'refunded'].includes(s.phase) || s.route === 'judge' || s.route === 'person' },
  { name: 'an-unrefunded-ending-has-a-reason', pred: (s) => !['declined', 'failed', 'cancelled'].includes(s.phase) || s.reason !== '' },
];
