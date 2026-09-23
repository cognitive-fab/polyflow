// What refund-triage may EMIT, on every reachable path over its declared domain.
'use strict';

const clearedByJudge = (a) => a.action === 'ASSESSED' && a.data?.reasonStated === true && a.data?.fraud === false;

export const effectInvariants = [
  {
    // The rule the judge exists to serve: money moves only when the judge
    // cleared the request, or a person approved it — never on an abstention.
    name: 'no-refund-unless-the-judge-cleared-it-or-a-person-approved',
    pred: (path) => path.emitted.every((e, i) =>
      e.kind !== 'refund'
      || path.actionBefore('APPROVED', i)
      || path.actions.some((a, j) => clearedByJudge(a) && j <= e.step)),
  },
  {
    name: 'at-most-one-refund-per-path',
    pred: (path) => path.count('refund') <= 1,
  },
  {
    // A fraud signal always reaches a person before any money moves.
    name: 'a-fraud-signal-is-never-refunded-by-the-judge',
    pred: (path) => path.emitted.every((e, i) =>
      e.kind !== 'refund'
      || !path.actions.some((a) => a.action === 'ASSESSED' && a.data?.fraud === true)
      || path.actionBefore('APPROVED', i)),
  },
];
