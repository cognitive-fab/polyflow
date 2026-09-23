// What this workflow may EMIT, on every reachable path — the admission gate.
// Upstream, the compensation discipline lives in a try/catch and an array a
// reviewer reads. Here it is sentences admission proves over every path the
// contract's domain allows, and the certificate names.
'use strict';

const FORWARD = ['createAccount', 'addAddress', 'addClient', 'addBankAccount', 'addKycCheck'];
const UNDO = { disconnectBankAccounts: 'BANK_ADDED', removeClient: 'CLIENT_ADDED', clearPostalAddresses: 'ADDRESS_ADDED' };

export const effectInvariants = [
  {
    // A compensation is only ever emitted for a step that succeeded before it.
    name: 'compensation-only-for-a-step-that-succeeded',
    pred: (path) => path.emitted.every((e, i) => !(e.kind in UNDO) || path.actionBefore(UNDO[e.kind], i)),
  },
  {
    // Once compensating, no forward step is emitted again.
    name: 'no-forward-step-after-compensating-began',
    pred: (path) => {
      const first = path.emitted.findIndex((e) => e.kind in UNDO);
      return first < 0 || path.emitted.slice(first).every((e) => !FORWARD.includes(e.kind));
    },
  },
  {
    // Compensations run last first: bank, then client, then address.
    name: 'compensations-are-lifo',
    pred: (path) => {
      const at = (k) => path.emitted.find((e) => e.kind === k)?.step;
      const [b, c, a] = [at('disconnectBankAccounts'), at('removeClient'), at('clearPostalAddresses')];
      const before = (x, y) => x === undefined || y === undefined || x < y;
      return before(b, c) && before(c, a) && before(b, a);
    },
  },
  {
    // Each step, forward or compensating, at most once per path.
    name: 'each-step-at-most-once',
    pred: (path) => [...FORWARD, ...Object.keys(UNDO)].every((k) => path.count(k) <= 1),
  },
  {
    // The steps go in order: none is emitted before the one before it succeeded.
    name: 'forward-steps-in-order',
    pred: (path) => path.emitted.every((e, i) => {
      const n = FORWARD.indexOf(e.kind);
      return n <= 0 || path.actionBefore(['ACCOUNT_CREATED', 'ADDRESS_ADDED', 'CLIENT_ADDED', 'BANK_ADDED'][n - 1], i);
    }),
  },
  {
    // Exactly one account creation per started run.
    name: 'exactly-one-create-when-started',
    pred: (path) => {
      const started = path.actions.some((a) => a.action === 'START');
      const n = path.count('createAccount');
      return started ? n === 1 : n === 0;
    },
  },
];
