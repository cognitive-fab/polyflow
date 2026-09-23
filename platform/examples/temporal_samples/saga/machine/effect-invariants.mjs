// What this workflow may EMIT, on every reachable path — the admission gate.
// Upstream, the compensation discipline lives in a try/catch and an array a
// reviewer reads. Here it is sentences admission proves over every path the
// contract's domain allows, and the certificate names.
'use strict';

const FORWARD = ['createAccount', 'addAddress', 'addClient', 'addBankAccount'];
const UNDO = { removeClient: 'CLIENT_ADDED', clearPostalAddresses: 'ADDRESS_ADDED' };

const COMPLETIONS = { ACCOUNT_CREATED: 'createAccount', ACCOUNT_FAILED: 'createAccount', ADDRESS_ADDED: 'addAddress', ADDRESS_FAILED: 'addAddress', CLIENT_ADDED: 'addClient', CLIENT_FAILED: 'addClient', BANK_ADDED: 'addBankAccount', BANK_FAILED: 'addBankAccount', CLIENT_REMOVED: 'removeClient', CLIENT_REMOVE_FAILED: 'removeClient', ADDRESSES_CLEARED: 'clearPostalAddresses', ADDRESSES_CLEAR_FAILED: 'clearPostalAddresses' };
// [a compensation, the success that makes a later compensation due first, that compensation]
const DUE_FIRST = [['clearPostalAddresses', 'CLIENT_ADDED', 'removeClient']];

export const effectInvariants = [
  {
    // A completion (success or failure) is only ever stepped after its order
    // was emitted: no step is skipped by a stale or forged completion.
    name: 'no-completion-without-its-order',
    pred: (path) => path.actions.every((a, j) => !(a.action in COMPLETIONS) ||
      path.emitted.some((e) => e.kind === COMPLETIONS[a.action] && e.step <= j)),
  },
  {
    // Nothing that succeeded is skipped on the way back: the address is cleared
    // only after the client (if added) was removed, and so on up the chain.
    name: 'every-succeeded-step-is-compensated-first',
    pred: (path) => path.emitted.every((e, i) => DUE_FIRST.every(([comp, success, due]) =>
      e.kind !== comp || !path.actionBefore(success, i) || path.emitted.some((d) => d.kind === due && d.step < e.step))),
  },
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
    // Compensations run last first: the client is removed before the address is cleared.
    name: 'compensations-are-lifo',
    pred: (path) => {
      const rc = path.emitted.find((e) => e.kind === 'removeClient');
      const ca = path.emitted.find((e) => e.kind === 'clearPostalAddresses');
      return !rc || !ca || rc.step < ca.step;
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
      return n <= 0 || path.actionBefore(['ACCOUNT_CREATED', 'ADDRESS_ADDED', 'CLIENT_ADDED'][n - 1], i);
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
