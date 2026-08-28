// What this workflow may EMIT, on every reachable path — the admission gate.
//
// Every rule here was mined, not chosen. Each carries the support that produced
// it, because a proposal is only legitimate while the standard is the user's own
// (spec §4.4.1). "You did this 12 of 14 times" is a rule. "This is good practice"
// is somebody else's opinion wearing a finding's clothes.
'use strict';

export const effectInvariants = [
  {
    // own evidence: 12 of 14 pushes in code-kanjo were preceded by a passing
    // verification. This rule is the other two.
    name: 'no-push-without-a-passing-verify',
    pred: (path) => path.emitted.every((e, i) =>
      e.kind !== 'push' || path.actionBefore('VERIFY_PASSED', i)),
  },
  {
    // own evidence: 14 of 14. Never violated, and worth keeping anyway — a
    // second push is the shape of a retry that was really a duplicate.
    name: 'at-most-one-push-per-run',
    pred: (path) => path.count('push') <= 1,
  },
  {
    // own evidence: 23 of 23 commits were preceded by a stage.
    name: 'commit-implies-a-prior-stage',
    pred: (path) => path.emitted.every((e) =>
      e.kind !== 'commit'
      || path.emitted.some((s) => s.kind === 'stage' && s.step < e.step)),
  },
  {
    // The rule that makes the other three mean something: a run that verifies
    // does so once. Re-verifying after a failure would let a run try until the
    // suite happened to pass.
    name: 'at-most-one-verify-per-run',
    pred: (path) => path.count('verify') <= 1,
  },
];
