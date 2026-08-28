// verified-push — SAM v2 strict-profile module.
//
// The shape polyness proposes for a step you already take: verify, stage,
// commit, push. What makes it a workflow rather than a checklist is that
// 'pushing' is reachable only through 'verifying' having passed — so the rule
// is a property of the state machine, not a line in a prompt.
//
// Every not-applicable action is an observable reject(reason): a duplicate
// report, a result for a step that already resolved, or a completion arriving
// after the run moved on are ordinary events here, not faults.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'verifiedPush' });

const INITIAL_STATE = { phase: 'idle', verified: false, reason: '' };

// NOTE: each action needs its OWN function — the library stamps __actionName
// onto the function object, so a shared reference would alias every intent to
// the last-declared name.
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      phase: { type: 'string' },
      verified: { type: 'boolean' },
      reason: { type: 'string' },
    },
    actions: {
      START: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      VERIFY_PASSED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      VERIFY_FAILED: {
        action: (data = {}) => ({ ...data }),
        schema: {},
        domain: [{ reason: 'tests-failed' }],
      },
      STAGED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      COMMITTED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      PUSHED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      PUSH_FAILED: {
        action: (data = {}) => ({ ...data }),
        schema: {},
        domain: [{ reason: 'remote-rejected' }],
      },
    },
    acceptors: {
      START: (model) => (proposal, { reject, next }) => {
        if (model.phase !== 'idle') return reject('already-started');
        next.phase = 'verifying';
        next.verified = false;
        next.reason = '';
      },
      VERIFY_PASSED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'verifying') return reject('stale-completion');
        next.phase = 'staging';
        next.verified = true;
        unchanged('reason');
      },
      VERIFY_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'verifying') return reject('stale-completion');
        // Straight to terminal. There is nothing to stage, and the push is
        // unreachable from here — which is the entire proposal.
        next.phase = 'blocked';
        next.reason = String(proposal.reason || 'tests-failed');
        unchanged('verified');
      },
      STAGED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'staging') return reject('stale-completion');
        next.phase = 'committing';
        unchanged('verified', 'reason');
      },
      COMMITTED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'committing') return reject('stale-completion');
        next.phase = 'pushing';
        unchanged('verified', 'reason');
      },
      PUSHED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'pushing') return reject('nothing-awaiting-a-push');
        next.phase = 'pushed';
        unchanged('verified', 'reason');
      },
      PUSH_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'staging' && model.phase !== 'committing' && model.phase !== 'pushing') {
          return reject('nothing-awaiting-a-push');
        }
        next.phase = 'blocked';
        next.reason = String(proposal.reason || 'remote-rejected');
        unchanged('verified');
      },
    },
    reactors: [],
  },
});

const { intents } = control;

const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };

const init = () => {
  try {
    const model = instance({}).state();
    if (model && typeof model.clearError === 'function') model.clearError();
  } catch { /* best-effort; strict-profile errors throw at the caller anyway */ }
  setState(INITIAL_STATE);
};

const actions = Object.fromEntries(
  Object.keys(intents).map((name) => [name, (data = {}) => intents[name](data)])
);

module.exports = { instance, init, actions, getState, setState };
