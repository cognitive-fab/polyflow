// review-probe — a SAM v2 strict-profile machine for the P2/P3 review tests.
// START -> working (orders `work`, arms a 10-minute deadline); WORK_DONE ->
// ready; FINISH -> done (terminal; orders `notify` on the way in). BOOM is
// accepted in any live state and its mapper emits an undeclared kind: the
// "certified machine does something impossible" case that poisons a run.
'use strict';
const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'reviewProbe' });
const INITIAL_STATE = { phase: 'idle', n: 0 };

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { phase: { type: 'string' }, n: { type: 'number' } },
    actions: {
      START: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      WORK_DONE: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      FINISH: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      NOTIFIED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      BOOM: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
    },
    acceptors: {
      START: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'idle') return reject('already-started');
        next.phase = 'working';
        unchanged('n');
      },
      WORK_DONE: (model) => (proposal, { reject, next }) => {
        if (model.phase !== 'working') return reject('stale-completion');
        next.phase = 'ready';
        next.n = model.n + 1;
      },
      FINISH: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.phase !== 'working' && model.phase !== 'ready') return reject('nothing-to-finish');
        next.phase = 'done';
        unchanged('n');
      },
      NOTIFIED: (model) => (proposal, { reject, unchanged }) => {
        if (model.phase !== 'done') return reject('stale-completion');
        unchanged('phase', 'n');
      },
      BOOM: (model) => (proposal, { reject, next }) => {
        if (model.phase === 'idle' || model.phase === 'done') return reject('not-live');
        next.phase = model.phase;
        next.n = model.n + 100;
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
  } catch { /* best-effort */ }
  setState(INITIAL_STATE);
};
const actions = Object.fromEntries(Object.keys(intents).map((name) => [name, (data = {}) => intents[name](data)]));
module.exports = { instance, init, actions, getState, setState };
