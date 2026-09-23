// @cognitive-fab/polyflow-verify — the half anyone may run: read a ledger a
// worker wrote (or rebuild it from a Temporal history), check the chain, check
// the signed heads against a trust store, and say whether the record is
// consistent, closed and signed. Apache-2.0, on purpose: an auditor, a
// customer's security team or Temporal itself verifies a record without a
// licence conversation. Nothing here governs anything.
export { fileSink, memorySink, runPaths, readJsonl, signHead, verifyHead, generateSigningKey, headMessage, partitionDelta } from './sink.mjs';
export { ledgerFromHistory } from './history.mjs';
export { LEDGER_HEADER, HEAD_HEADER, FLUSH_ACTIVITY } from './constants.mjs';
export { verifyBundle, verifyThread } from './verify.mjs';
