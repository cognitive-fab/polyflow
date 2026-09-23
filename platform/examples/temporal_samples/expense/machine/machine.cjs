// expense — SAM v2 strict-profile module: Temporal's `expense` sample as a
// machine. Create the expense, wait for a person's approval (or a timeout),
// pay once. Every not-applicable action is an observable reject(reason).
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'expense' });

const INITIAL_STATE = { expenseState: 'idle', expenseId: '', reason: '' };

// NOTE: each action needs its OWN function — the library stamps __actionName
// onto the function object, so a shared reference would alias every intent.
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      expenseState: { type: 'string' },
      expenseId: { type: 'string' },
      reason: { type: 'string' },
    },
    actions: {
      START: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ expenseId: 'my-business-id' }] },
      CREATED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      CREATE_FAILED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reason: 'server-unavailable' }] },
      APPROVE: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      REJECT: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reason: 'rejected' }, { reason: 'approver-unreachable' }] },
      APPROVAL_TIMEOUT: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      PAID: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      PAY_FAILED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reason: 'payment-declined' }] },
      STOP: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
    },
    acceptors: {
      START: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.expenseState !== 'idle') return reject('already-started');
        if (typeof proposal.expenseId !== 'string' || proposal.expenseId === '') return reject('expense-id-required');
        next.expenseState = 'creating';
        next.expenseId = proposal.expenseId;
        unchanged('reason');
      },
      CREATED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.expenseState !== 'creating') return reject('stale-completion');
        next.expenseState = 'pending_approval';
        unchanged('expenseId', 'reason');
      },
      CREATE_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.expenseState !== 'creating') return reject('stale-completion');
        next.expenseState = 'failed';
        next.reason = String(proposal.reason || 'create-failed');
        unchanged('expenseId');
      },
      // The person's answer. Only while the request is out: an approval that
      // arrives after the window closed, or twice, is a reject, never a payment.
      APPROVE: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.expenseState !== 'pending_approval') return reject('nothing-awaiting-approval');
        next.expenseState = 'paying';
        unchanged('expenseId', 'reason');
      },
      REJECT: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.expenseState !== 'pending_approval') return reject('nothing-awaiting-approval');
        next.expenseState = 'rejected';
        next.reason = String(proposal.reason || 'rejected');
        unchanged('expenseId');
      },
      APPROVAL_TIMEOUT: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.expenseState !== 'pending_approval') return reject('nothing-awaiting-approval');
        next.expenseState = 'timed_out';
        next.reason = 'timed-out';
        unchanged('expenseId');
      },
      PAID: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.expenseState !== 'paying') return reject('stale-completion');
        next.expenseState = 'completed';
        unchanged('expenseId', 'reason');
      },
      PAY_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.expenseState !== 'paying') return reject('stale-completion');
        next.expenseState = 'failed';
        next.reason = String(proposal.reason || 'payment-failed');
        unchanged('expenseId');
      },
      STOP: (model) => (proposal, { reject, next, unchanged }) => {
        // A person can always stop the run — except while the payment is in
        // flight, which stopping would not unpay (declared unstoppable).
        if (!['idle', 'creating', 'pending_approval'].includes(model.expenseState)) return reject('nothing-to-stop');
        next.expenseState = 'stopped';
        next.reason = 'stopped';
        unchanged('expenseId');
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
