// refund-triage — SAM v2 strict-profile module.
//
// The judge's answer arrives as ASSESSED with two facts, each true, false or
// ABSENT (the judge abstained). Only "a reason is stated" AND "no fraud" routes
// straight to a refund; anything else, including any abstention, goes to a
// person. The machine never reads a probability: the bands already turned it
// into a fact or into nothing.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'refundTriage' });
const INITIAL_STATE = { phase: 'idle', message: '', route: '', reason: '' };

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      phase: { type: 'string' },
      message: { type: 'string' },
      route: { type: 'string' },
      reason: { type: 'string' },
    },
    actions: {
      START: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ message: 'my order arrived broken, please refund' }] },
      ASSESSED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reasonStated: true, fraud: true }, { reasonStated: true, fraud: false }, { reasonStated: true, fraud: null }, { reasonStated: false, fraud: true }, { reasonStated: false, fraud: false }, { reasonStated: false, fraud: null }, { reasonStated: null, fraud: true }, { reasonStated: null, fraud: false }, { reasonStated: null, fraud: null }] },
      ASSESS_FAILED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reason: 'judge-unavailable' }] },
      APPROVED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      DECLINED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reason: 'not-eligible' }] },
      REFUNDED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      REFUND_FAILED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reason: 'card-declined' }] },
      CANCEL: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
    },
    acceptors: {
      START: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'idle') return reject('already-started');
        next.phase = 'assessing';
        next.message = String(proposal.message ?? '');
        unchanged('route', 'reason');
      },
      ASSESSED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'assessing') return reject('stale-completion');
        const clear = proposal.reasonStated === true && proposal.fraud === false;
        next.phase = clear ? 'refunding' : 'reviewing';
        next.route = clear ? 'judge' : '';
        unchanged('message', 'reason');
      },
      ASSESS_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
        // No judge is not a reason to refund, or to refuse: a person decides.
        if (model.phase !== 'assessing') return reject('stale-completion');
        next.phase = 'reviewing';
        unchanged('message', 'route', 'reason');
      },
      APPROVED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'reviewing') return reject('nothing-awaiting-review');
        next.phase = 'refunding';
        next.route = 'person';
        unchanged('message', 'reason');
      },
      DECLINED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'reviewing') return reject('nothing-awaiting-review');
        next.phase = 'declined';
        next.reason = String(proposal.reason || 'declined');
        unchanged('message', 'route');
      },
      REFUNDED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'refunding') return reject('stale-completion');
        next.phase = 'refunded';
        unchanged('message', 'route', 'reason');
      },
      REFUND_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'refunding') return reject('stale-completion');
        next.phase = 'failed';
        next.reason = String(proposal.reason || 'refund-failed');
        unchanged('message', 'route');
      },
      CANCEL: (model) => (proposal, { reject, next, unchanged }) => {
        if (!['idle', 'assessing', 'reviewing'].includes(model.phase)) return reject('too-late-to-cancel');
        next.phase = 'cancelled';
        next.reason = 'cancelled';
        unchanged('message', 'route');
      },
    },
    reactors: [],
  },
});

const { intents } = control;
const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };
const init = () => {
  try { const model = instance({}).state(); if (model && typeof model.clearError === 'function') model.clearError(); } catch { /* strict errors throw at the caller */ }
  setState(INITIAL_STATE);
};
const actions = Object.fromEntries(Object.keys(intents).map((name) => [name, (data = {}) => intents[name](data)]));

module.exports = { instance, init, actions, getState, setState };
