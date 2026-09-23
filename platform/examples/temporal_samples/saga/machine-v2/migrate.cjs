'use strict';
// migrate.cjs — v1 -> v2 of the saga machine. Pure by contract: (oldState) ->
// newState, no I/O, no clock; the migrate gate enforces determinism by double
// application.
//
// v2 only WIDENS the shape: `phase` gains 'adding_kyc' and 'undo_bank',
// `failedStep` gains 'addKycCheck', `params.failAt` gains 'addKycCheck'. Every
// v1 value is a v2 value, so each key carries over unchanged. A run parked in
// 'adding_bank' under v1 takes the new path when its bank step completes
// (BANK_ADDED now leads to 'adding_kyc'); a run already 'opened' is done.
module.exports.migrate = function migrate(oldState) {
  const next = {};
  next["phase"] = oldState["phase"];
  next["params"] = oldState["params"];
  next["failedStep"] = oldState["failedStep"];
  next["reason"] = oldState["reason"];
  return next;
};
