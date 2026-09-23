// Effect mapper — pure, edge-triggered on state transitions. No I/O, no clock,
// no randomness. An effect is a WORK ORDER: the sample's activity of the same
// name performs it, with the sample's own command as payload.
//
// `params.failAt` reproduces the sample's failure injection (`shouldThrow` on
// the command): upstream's workflow always passes it to addBankAccount, so the
// sample's demo is the compensating path.
'use strict';

const withThrow = (params, step, payload) =>
  params.failAt === step ? { ...payload, shouldThrow: `${step} failed` } : payload;

module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const entered = (s) => pre.phase !== s && post.phase === s;
  const p = post.params;
  const out = [];

  if (entered('creating_account')) out.push({ kind: 'createAccount', payload: withThrow(p, 'createAccount', { accountId: p.accountId }) });
  if (entered('adding_address')) out.push({ kind: 'addAddress', payload: withThrow(p, 'addAddress', { accountId: p.accountId, address: p.address }) });
  if (entered('adding_client')) out.push({ kind: 'addClient', payload: withThrow(p, 'addClient', { accountId: p.accountId, clientEmail: p.clientEmail }) });
  if (entered('adding_bank')) out.push({ kind: 'addBankAccount', payload: withThrow(p, 'addBankAccount', { accountId: p.accountId, details: p.bankDetails }) });
  // Compensations, last first.
  if (entered('undo_client')) out.push({ kind: 'removeClient', payload: { accountId: p.accountId } });
  if (entered('undo_address')) out.push({ kind: 'clearPostalAddresses', payload: { accountId: p.accountId } });
  return out;
};
