'use strict';
// migrate.cjs — SCAFFOLDED by polyvers from the shape diff
// (old contract 0f0d4f0ae006 → new contract 08b8ecf31ab8).
// Pure by contract: (oldState) → newState, no I/O, no clock — the migrate
// gate enforces determinism by double application.
// HOLE: an unfilled TODO fails the migrate gate loudly — each hole throws
// independently, so deleting one line cannot silently drop a key.
const HOLE = (msg) => { throw new Error(msg); };
module.exports.migrate = function migrate(oldState) {
  const next = {};
  // carried over unchanged
  next["ticketCount"] = oldState["ticketCount"];
  next["reason"] = oldState["reason"];
  // retyped: enum: 'idle' | 'gathering' | 'drafting' | 'review' | 'posting' | 'posted' | 'denied' | 'failed' → enum: 'idle' | 'gathering' | 'drafting' | 'review' | 'posting' | 'posted' | 'denied' | 'failed' | 'cancelled'
  // v2 only WIDENS the enum (adds 'cancelled'): every v1 value is a v2 value.
  next["briefState"] = oldState["briefState"];
  return next;
};
