// P9 security review — the governance service's tenancy. Each test asserts a
// property NFR-8 (namespace-scoped access) implies and fails today for the
// reason in its message. Loopback only. See docs/platform/reviews/P9-security-review.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '@cognitive-fab/polyflow-kernel';
import { Store, createService } from '../src/index.mjs';

let service;
let url;
before(async () => {
  // Small limits so the test is quick; the defaults are 256 per run and 4096 in total.
  service = createService({
    store: new Store(':memory:', { maxPendingPerRun: 256, maxPending: 8 }),
    tokens: [{ token: 'tenant-a', namespaces: ['acme'] }, { token: 'tenant-b', namespaces: ['globex'] }],
  });
  await new Promise((r) => service.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${service.server.address().port}`;
});
after(() => service.server.close());

const post = (token, body) => fetch(`${url}/v1/ledger`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

/** A delta that starts past seq 0 of a run the service has never seen: it is held back. */
function aheadDelta(run) {
  const l = openLedger({ run });
  l.append('admission', { level: 'observe', policy: null }, 1000);
  l.append('proposal', { source: 'workflow', action: 'x' }, 1001);
  l.append('closure', { outcome: 'completed' }, 1002);
  return l.drain().slice(1); // seq 1..2; seq 0 never comes
}

test('SEC-SV1: one namespace cannot exhaust the hold-back buffer that another namespace\'s out-of-order deltas need', async () => {
  // Tenant A holds a token for its own namespace only, and sends deltas for runs
  // that will never fill their hole. Nothing ever expires them.
  for (let i = 0; i < 8; i++) {
    const r = await post('tenant-a', { events: aheadDelta({ ns: 'acme', wf: `junk-${i}`, run: 'r' }) });
    assert.equal(r.status, 202, 'setup: held back');
  }
  // Tenant B's worker ships the second of two parallel activities' deltas first (review SL).
  const r = await post('tenant-b', { events: aheadDelta({ ns: 'globex', wf: 'real-run', run: 'r' }) });
  const body = await r.json();
  assert.equal(r.status, 202, `SEC-SV1: namespace 'globex' got ${r.status} (${body.error}) because namespace 'acme' filled the service-wide hold-back buffer; the exporter swallows the error, so globex's ledger now has a gap it did not cause`);
});
