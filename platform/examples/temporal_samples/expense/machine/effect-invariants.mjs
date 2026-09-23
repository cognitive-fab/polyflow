// What this workflow may EMIT, on every reachable path — the admission gate.
// Upstream, "no payment without approval" is a property of one `if` in
// workflows.ts that a reviewer reads. Here it is a sentence admission proves
// over every path the contract's domain allows, and the certificate names.
'use strict';

export const effectInvariants = [
  {
    // Money leaves once, at most.
    name: 'at-most-one-payment-per-path',
    pred: (path) => path.count('payment') <= 1,
  },
  {
    // A payment is only ever emitted on a path where a person said yes first.
    name: 'no-payment-without-prior-approve',
    pred: (path) => path.emitted.every((e, i) =>
      e.kind !== 'payment' || path.actionBefore('APPROVE', i)),
  },
  {
    // ...and the approval was asked for, not assumed.
    name: 'payment-implies-approval-was-requested',
    pred: (path) => path.emitted.every((e) =>
      e.kind !== 'payment' ||
      path.emitted.some((r) => r.kind === 'request_approval' && r.step < e.step)),
  },
  {
    // A rejection or a timeout ends the run: nothing is paid on such a path.
    name: 'no-payment-after-reject-or-timeout',
    pred: (path) => !path.actions.some((a) => a.action === 'REJECT' || a.action === 'APPROVAL_TIMEOUT') || path.count('payment') === 0,
  },
  {
    // Nothing is paid, or asked about, for an expense that was never created.
    name: 'create-before-anything-else',
    pred: (path) => path.emitted.every((e) =>
      e.kind === 'createExpense' ||
      path.emitted.some((c) => c.kind === 'createExpense' && c.step < e.step)),
  },
  {
    // Exactly one create per started run — no re-create loops.
    name: 'exactly-one-create-when-started',
    pred: (path) => {
      const started = path.actions.some((a) => a.action === 'START');
      const n = path.count('createExpense');
      return started ? n === 1 : n === 0;
    },
  },
];
