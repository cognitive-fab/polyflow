// Rebuild a run's ledger from its Temporal event history — `polyflow export`.
//
// The ledger rides on activity headers, and ActivityTaskScheduled events
// persist their headers, so the history alone is enough to recover every
// event that had a carrier. This is the backstop that makes the sink's
// availability irrelevant to completeness: a sink that was down loses nothing.
//
// Accepts either the object a client's fetchHistory() returns (payload data as
// Uint8Array) or the JSON `temporal workflow show --output json` prints
// (payload data as base64 strings).

import { defaultPayloadConverter } from '@temporalio/common';
import { openHeader } from '@cognitive-fab/polyflow-kernel';
import { LEDGER_HEADER } from './constants.mjs';

const bytes = (v) => (v == null ? v : typeof v === 'string' ? Uint8Array.from(Buffer.from(v, 'base64')) : v);

function decode(payload) {
  const metadata = {};
  for (const [k, v] of Object.entries(payload.metadata ?? {})) metadata[k] = bytes(v);
  return defaultPayloadConverter.fromPayload({ metadata, data: bytes(payload.data) });
}

/**
 * Every ledger event carried in a history, in seq order, de-duplicated.
 * Sealed headers (plan P2.6) are opened with `headerKeys` (keyId -> base64 key).
 */
export function ledgerFromHistory(history, { headerKeys = {} } = {}) {
  const bySeq = new Map();
  for (const e of history.events ?? []) {
    // Only activities carry the ledger (review L2); a child-start header is not read (P9 SEC-EXP1).
    const attrs = e.activityTaskScheduledEventAttributes;
    const p = attrs?.header?.fields?.[LEDGER_HEADER];
    if (!p) continue;
    // With keys given, every header must be sealed, as the exporter requires (SEC-EXP1/EX2).
    const { events } = openHeader(decode(p), headerKeys, { required: Object.keys(headerKeys).length > 0, expect: { purpose: 'ledger' } });
    for (const ev of events) if (!bySeq.has(ev.seq)) bySeq.set(ev.seq, ev);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
