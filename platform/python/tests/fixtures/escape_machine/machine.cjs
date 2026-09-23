// A hostile "machine" for the QuickJS sandbox tests. It implements the SAM v2
// module surface by hand (no sam-pattern) and each action tries something a
// certified machine must never be able to do.
'use strict';

let state = { phase: 'idle' };
let last = null;
const act = (name, fn) => (data) => { last = { intent: name, classification: 'accepted' }; fn(data); };
const g = globalThis;

module.exports = {
  instance: () => ({ validate: () => [], lastStep: () => last }),
  init: () => { state = { phase: 'idle' }; last = null; },
  getState: () => ({ ...state }),
  setState: (s) => { state = { ...s }; },
  actions: {
    OK: act('OK', () => { state.phase = 'done'; }),
    PROBE: act('PROBE', () => {
      state.phase = ['require', 'process', 'std', 'os', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Deno', 'Bun', 'print', 'scriptArgs']
        .map((k) => `${k}:${typeof g[k]}`).join(',');
    }),
    DYNAMIC_REQUIRE: act('DYNAMIC_REQUIRE', () => { const r = require; r(['f', 's'].join('')); }),
    CLOCK: act('CLOCK', () => { state.phase = String(Date.now()); }),
    NEW_DATE: act('NEW_DATE', () => { state.phase = String(new Date().getTime()); }),
    SWALLOWED_RANDOM: act('SWALLOWED_RANDOM', () => { try { Math.random(); } catch { /* hidden */ } state.phase = 'done'; }),
    RANDOM: act('RANDOM', () => { state.phase = String(Math.random()); }),
    TIMER: act('TIMER', () => { setTimeout(() => {}, 0); }),
    SPIN: act('SPIN', () => { for (;;) { /* runaway */ } }),
    HOG: act('HOG', () => { const a = []; for (;;) a.push(new Array(100000).fill(1)); }),
    DEEP: act('DEEP', () => { const f = (n) => f(n + 1) + 1; f(0); }),
  },
};
