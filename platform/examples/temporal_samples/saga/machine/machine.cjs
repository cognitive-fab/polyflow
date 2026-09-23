// saga — SAM v2 strict-profile module: Temporal's `saga` sample (openAccount)
// as a machine. Four forward steps in sequence; a failure compensates the
// steps that succeeded before it, last first. Every not-applicable action is
// an observable reject(reason).
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'saga' });

const INITIAL_STATE = { phase: 'idle', params: {}, failedStep: '', reason: '' };

// The sample's OpenAccount command, as START's data. `failAt` is the sample's
// failure injection (`shouldThrow` on that step's command).
const COMMAND = {
  accountId: 'acc-1', bankId: 'Foo Bar Savings and Loan', clientEmail: 'bart@simpson.io',
  address: { address1: '123 Temporal Street', postalCode: '98006' },
  bankDetails: { accountNumber: '111', routingNumber: '1234555', accountType: 'Checking', personalOwner: { firstName: 'Bart', lastName: 'Simpson' } },
};

// A forward step's completion: `next` on success; on failure, the first
// compensation for what succeeded before it, or `failed` when nothing did.
const forward = (awaiting, step, ok, undo) => ({
  ok: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.phase !== awaiting) return reject('stale-completion');
    next.phase = ok;
    unchanged('params', 'failedStep', 'reason');
  },
  failed: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.phase !== awaiting) return reject('stale-completion');
    next.phase = undo;
    next.failedStep = step;
    next.reason = String(proposal.reason || 'step-failed');
    unchanged('params');
  },
});
// A compensation's completion: on to the next compensation, or the end.
const compensation = (awaiting, ok) => ({
  ok: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.phase !== awaiting) return reject('stale-completion');
    next.phase = ok;
    unchanged('params', 'failedStep', 'reason');
  },
  failed: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.phase !== awaiting) return reject('stale-completion');
    next.phase = 'compensation_failed';
    next.reason = String(proposal.reason || 'compensation-failed');
    unchanged('params', 'failedStep');
  },
});

const account = forward('creating_account', 'createAccount', 'adding_address', 'failed');
const address = forward('adding_address', 'addAddress', 'adding_client', 'failed');
const client = forward('adding_client', 'addClient', 'adding_bank', 'undo_address');
const bank = forward('adding_bank', 'addBankAccount', 'opened', 'undo_client');
const undoClient = compensation('undo_client', 'undo_address');
const undoAddress = compensation('undo_address', 'compensated');

const CANCEL_TO = { adding_client: { phase: 'undo_address', step: 'addClient' }, adding_bank: { phase: 'undo_client', step: 'addBankAccount' } };
const FAIL_AT = ['createAccount', 'addAddress', 'addClient', 'addBankAccount'];

const action = () => (data = {}) => ({ ...data });

// NOTE: each action needs its OWN function — the library stamps __actionName
// onto the function object, so a shared reference would alias every intent.
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      phase: { type: 'string' },
      params: { type: 'object' },
      failedStep: { type: 'string' },
      reason: { type: 'string' },
    },
    actions: {
      START: { action: action(), schema: {}, domain: [{ ...COMMAND, failAt: '' }, { ...COMMAND, failAt: 'addBankAccount' }] },
      ACCOUNT_CREATED: { action: action(), schema: {}, domain: [{}] },
      ACCOUNT_FAILED: { action: action(), schema: {}, domain: [{ reason: 'step-failed' }] },
      ADDRESS_ADDED: { action: action(), schema: {}, domain: [{}] },
      ADDRESS_FAILED: { action: action(), schema: {}, domain: [{ reason: 'step-failed' }] },
      CLIENT_ADDED: { action: action(), schema: {}, domain: [{}] },
      CLIENT_FAILED: { action: action(), schema: {}, domain: [{ reason: 'step-failed' }] },
      BANK_ADDED: { action: action(), schema: {}, domain: [{}] },
      BANK_FAILED: { action: action(), schema: {}, domain: [{ reason: 'step-failed' }] },
      CLIENT_REMOVED: { action: action(), schema: {}, domain: [{}] },
      CLIENT_REMOVE_FAILED: { action: action(), schema: {}, domain: [{ reason: 'compensation-failed' }] },
      ADDRESSES_CLEARED: { action: action(), schema: {}, domain: [{}] },
      ADDRESSES_CLEAR_FAILED: { action: action(), schema: {}, domain: [{ reason: 'compensation-failed' }] },
      STOP: { action: action(), schema: {}, domain: [{}] },
      CANCEL: { action: action(), schema: {}, domain: [{}] },
    },
    acceptors: {
      START: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'idle') return reject('already-started');
        if (typeof proposal.accountId !== 'string' || proposal.accountId === '') return reject('account-id-required');
        const { accountId, bankId, clientEmail, address, bankDetails, failAt } = proposal;
        if (failAt && !FAIL_AT.includes(failAt)) return reject('unknown-fail-at');
        next.phase = 'creating_account';
        next.params = { accountId, bankId, clientEmail, address, bankDetails, failAt: failAt || '' };
        unchanged('failedStep', 'reason');
      },
      ACCOUNT_CREATED: account.ok,
      ACCOUNT_FAILED: account.failed,
      ADDRESS_ADDED: address.ok,
      ADDRESS_FAILED: address.failed,
      CLIENT_ADDED: client.ok,
      CLIENT_FAILED: client.failed,
      BANK_ADDED: bank.ok,
      BANK_FAILED: bank.failed,
      CLIENT_REMOVED: undoClient.ok,
      CLIENT_REMOVE_FAILED: undoClient.failed,
      ADDRESSES_CLEARED: undoAddress.ok,
      ADDRESSES_CLEAR_FAILED: undoAddress.failed,
      STOP: (model) => (proposal, { reject, next, unchanged }) => {
        // A run with nothing to undo stops: before, or during, the two steps
        // that register no compensation upstream either. Past that, CANCEL.
        if (!['idle', 'creating_account', 'adding_address'].includes(model.phase)) return reject('nothing-to-stop');
        next.phase = 'stopped';
        next.reason = 'stopped';
        unchanged('params', 'failedStep');
      },
      CANCEL: (model) => (proposal, { reject, next, unchanged }) => {
        // A person calls the saga off: what succeeded is compensated, last
        // first, exactly as a failure of the step in flight would be.
        const undo = CANCEL_TO[model.phase];
        if (!undo) return reject('nothing-to-cancel');
        next.phase = undo.phase;
        next.failedStep = undo.step;
        next.reason = 'cancelled';
        unchanged('params');
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
