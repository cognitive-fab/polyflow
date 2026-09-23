import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/index.mjs';

test('the verify package exports the verifier, the sinks and the header names, and nothing that governs', () => {
  for (const name of ['verifyBundle', 'verifyThread', 'ledgerFromHistory', 'fileSink', 'memorySink', 'readJsonl', 'signHead', 'verifyHead', 'generateSigningKey', 'LEDGER_HEADER', 'HEAD_HEADER']) {
    assert.equal(typeof v[name], name === name.toUpperCase() ? 'string' : 'function', name);
  }
  for (const name of ['PolyflowPlugin', 'vet', 'startGoverned', 'checkMachineDir']) assert.equal(v[name], undefined, `${name} is not in the Apache half`);
});
