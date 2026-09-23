// The governance service's HTTP API — technical spec §11. node:http, no framework.
//
//   POST /v1/ledger                       { events, signedHead }  -> { written, skipped, conflicts, pending, applied }
//   GET  /v1/runs[?ns=]                   runs held
//   GET  /v1/runs/:ns/:wf/:run            { events, heads }
//   GET  /v1/runs/:ns/:wf/:run/verify     verifyBundle over what is held
//   GET  /v1/runs/:ns/:wf/:run/report     Markdown run report
//   GET  /v1/evidence?ns=&from=&to=       the evidence pack
//   POST /v1/certificates?ns=             register a certificate for a namespace (verified against the trust store)
//   GET  /v1/alerts                       tamper and gap alerts
//   GET  /metrics                         OpenMetrics
//   GET  /                                a read-only console
//
// Writes are authenticated with a bearer token (`tokens`); reads too, unless
// `publicReads` is set. A token is a string (every namespace) or
// `{ token, namespaces: [...] }` (only those: NFR-8). `/metrics` needs a token
// too unless `publicMetrics` is set: it names namespaces, rules and roles
// (P9 security review SEC-SV3). Each token (or, for public reads, each client
// address) is rate limited. Loopback by default. The service holds digests and
// decisions, never payloads: bodies stay under the customer's codec.
//
// A delta that arrives ahead of its predecessor is held back (202) and applied
// when the hole fills; see store.mjs. A signed head is verified against the
// service's trust store before anything of its delta is stored (review SV1):
// a service with no trust store refuses signed heads.
//
// Trust is per namespace (SEC-SV2). An entry is either
//   keyId: { pem, namespaces: ['acme', ...] }   trusted for those namespaces only
//   keyId: { pem, namespaces: '*' }             trusted for every namespace, said explicitly
//   keyId: '<pem>'                              the flat form: every namespace, as before —
//                                               for single-tenant installs; use the scoped form
//                                               when tokens are scoped to namespaces
// Where a namespace has any trusted key, the first delta of a run (the one
// carrying seq 0) must carry a head that key signed: a write token alone
// cannot start, and so cannot squat, a run's record.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { verifyChain, certificateDigest } from '@cognitive-fab/polyflow-kernel';
import { verifyBundle, verifyCertificate, verifyHead } from '@cognitive-fab/polyflow-temporal';
import { runReport, evidencePack, parsePeriod } from './evidence.mjs';

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const text = (res, code, body, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const refuse = (code, message) => Object.assign(new Error(message), { status: code });

async function body(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw refuse(413, 'body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch { throw refuse(400, 'the body is not JSON'); }
}

const isRun = (r) => Boolean(r) && typeof r === 'object' && ['ns', 'wf', 'run'].every((k) => typeof r[k] === 'string' && r[k].length > 0);
const sameRun = (a, b) => a.ns === b.ns && a.wf === b.wf && a.run === b.run;

/**
 * Why a delta's signed head cannot be stored, or null. It must name the
 * delta's run, anchor on an event of the delta, and verify against `trust`.
 */
export function headProblem(signedHead, events, trust) {
  if (!signedHead || typeof signedHead !== 'object') return 'signedHead is not an object';
  if (!isRun(signedHead.run) || !sameRun(signedHead.run, events[0].run)) return 'the signed head names another run than its delta';
  const at = events.find((e) => e.seq === signedHead.seq);
  if (!at || at.hash !== signedHead.hash) return `the signed head (seq ${signedHead.seq}) does not match an event of its delta`;
  if (typeof signedHead.keyId !== 'string' || typeof signedHead.sig !== 'string') return 'the signed head has no keyId or signature';
  const v = verifyHead(signedHead, trust);
  return v.ok ? null : `the signed head does not verify: ${v.reason}`;
}

/**
 * Normalise a trust store (see the header) to `ns -> { keyId: pem }`, the
 * flat form verifyHead and verifyBundle take.
 */
export function scopedTrust(trust = {}) {
  const entries = Object.entries(trust ?? {}).map(([keyId, v]) => {
    if (typeof v === 'string') return { keyId, pem: v, namespaces: null };
    if (!v || typeof v.pem !== 'string') throw new Error(`trust entry '${keyId}' needs a pem`);
    if (v.namespaces !== '*' && !(Array.isArray(v.namespaces) && v.namespaces.every((n) => typeof n === 'string'))) {
      throw new Error(`trust entry '${keyId}': namespaces must be a list of namespaces, or '*'`);
    }
    return { keyId, pem: v.pem, namespaces: v.namespaces === '*' ? null : v.namespaces };
  });
  const cache = new Map();
  return (ns) => {
    if (!cache.has(ns)) cache.set(ns, Object.fromEntries(entries.filter((e) => e.namespaces === null || e.namespaces.includes(ns)).map((e) => [e.keyId, e.pem])));
    return cache.get(ns);
  };
}

/** A token bucket per key: `take(key)` is 0 when allowed, else the seconds to wait. */
function rateLimiter({ perSecond, burst }, now = Date.now) {
  const buckets = new Map();
  return (key) => {
    const t = now();
    const b = buckets.get(key) ?? { tokens: burst, at: t };
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSecond);
    b.at = t;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.delete(buckets.keys().next().value);
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.ceil((1 - b.tokens) / perSecond);
  };
}

/** OpenMetrics: one family, with its `# TYPE`, and labelled samples. */
const label = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
function family(name, type, help, samples) {
  const out = [`# TYPE ${name} ${type}`, `# HELP ${name} ${help}`];
  const sample = type === 'counter' ? `${name}_total` : name;
  for (const { labels = {}, value } of samples) {
    const ls = Object.entries(labels).map(([k, v]) => `${k}="${label(v)}"`).join(',');
    out.push(`${sample}${ls ? `{${ls}}` : ''} ${value}`);
  }
  return out;
}

/**
 * @param {object} o
 * @param {import('./store.mjs').Store} o.store
 * @param {object} [o.trust]           see the header: keyId -> pem, or keyId -> { pem, namespaces }
 * @param {Array<string|{token:string, namespaces?:string[]}>} [o.tokens]
 * @param {boolean} [o.publicReads]
 * @param {boolean} [o.publicMetrics]  default false
 * @param {{perSecond:number, burst:number}|null} [o.rateLimit]  per token (or client address); null turns it off
 * @param {number} [o.maxEvents]       events in one delta
 * @param {{requestMs:number, headersMs:number, keepAliveMs:number}} [o.timeouts]
 */
export function createService({
  store, trust = {}, tokens = [], publicReads = false, publicMetrics = false,
  rateLimit = { perSecond: 50, burst: 200 }, maxEvents = 10_000,
  timeouts = { requestMs: 30_000, headersMs: 10_000, keepAliveMs: 5_000 },
}) {
  const trustFor = scopedTrust(trust);
  const limited = rateLimit ? rateLimiter(rateLimit) : () => 0;
  // Per process: traffic, not record. Everything derived from the ledgers is
  // computed from the store at scrape time, and survives a restart.
  const metrics = { deltas: 0, events: 0, conflicts: 0, refused: 0, pending: 0 };
  const grants = tokens.map((t) => (typeof t === 'string' ? { token: t, namespaces: null } : { token: String(t.token), namespaces: t.namespaces ?? null }));
  /** The grant a request's bearer token holds, or null. */
  const grantOf = (req) => {
    const h = String(req.headers.authorization ?? '');
    const t = h.startsWith('Bearer ') ? Buffer.from(h.slice(7)) : null;
    if (!t) return null;
    return grants.find((g) => { const b = Buffer.from(g.token); return b.length === t.length && timingSafeEqual(b, t); }) ?? null;
  };
  const ANY = { token: null, namespaces: null };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://service');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const write = req.method !== 'GET';
    const isMetrics = url.pathname === '/metrics';
    const grant = grantOf(req) ?? (!write && (publicReads || (isMetrics && publicMetrics)) ? ANY : null);
    if (!grant) return json(res, 401, { error: 'a bearer token is required' });
    const wait = limited(grant.token ?? `addr:${req.socket.remoteAddress}`);
    if (wait) { res.setHeader('retry-after', String(wait)); return json(res, 429, { error: 'too many requests' }); }
    const may = (ns) => grant.namespaces === null || grant.namespaces.includes(ns);
    const forbidden = (ns) => json(res, 403, { error: `this token is not granted namespace '${ns}'` });

    if (req.method === 'POST' && url.pathname === '/v1/ledger') {
      const { events, signedHead } = await body(req);
      if (!Array.isArray(events) || events.length === 0) return json(res, 400, { error: 'events required' });
      if (events.length > maxEvents) return json(res, 413, { error: `a delta holds at most ${maxEvents} events` });
      if (!events.every((e) => e && typeof e === 'object') || !isRun(events[0].run) || !Number.isSafeInteger(events[0].seq) || events[0].seq < 0) {
        return json(res, 400, { error: 'every event needs a run { ns, wf, run } and a seq, the first at 0 or more' });
      }
      if (!may(events[0].run.ns)) return forbidden(events[0].run.ns);
      const chk = verifyChain(events, { from: { seq: events[0].seq - 1, hash: events[0].prev } });
      if (!chk.ok) { metrics.refused++; return json(res, 422, { error: `the delta does not chain at seq ${chk.seq}: ${chk.reason}` }); }
      const keys = trustFor(events[0].run.ns);
      if (signedHead != null) {
        const why = headProblem(signedHead, events, keys);
        if (why) { metrics.refused++; return json(res, 422, { error: why }); }
      } else if (events[0].seq === 0 && Object.keys(keys).length && !store.head(events[0].run)) {
        metrics.refused++;
        return json(res, 422, { error: `namespace '${events[0].run.ns}' has a trust store: a run's first delta must carry a signed head` });
      }
      const r = store.writeEvents(events, signedHead ?? null, { token: grant.token });
      if (r.refused) { metrics.refused++; return json(res, 409, { error: r.refused, ...r }); }
      metrics.deltas++; metrics.events += r.written + r.applied; metrics.conflicts += r.conflicts.length;
      if (r.pending) metrics.pending++;
      return json(res, r.conflicts.length ? 409 : r.pending ? 202 : 200, r);
    }
    if (req.method === 'POST' && url.pathname === '/v1/certificates') {
      const cert = await body(req);
      if (!cert || typeof cert !== 'object' || !cert.subject?.machine || !cert.buildId) return json(res, 400, { error: 'not a certificate' });
      // The signature covers the digest; the digest must cover the body (review SV5).
      if (certificateDigest(cert) !== cert.digest) return json(res, 422, { error: 'the certificate was edited after it was sealed: its digest does not match its body' });
      const ns = url.searchParams.get('ns');
      if (!ns) return json(res, 400, { error: 'ns required: a certificate is registered for a namespace' });
      if (!may(ns)) return forbidden(ns);
      const v = verifyCertificate(cert, trustFor(ns));
      if (!v.ok) return json(res, 422, { error: v.reason });
      store.putCertificate(cert, ns);
      return json(res, 200, { buildId: cert.buildId, signedBy: v.keyId, ns });
    }
    if (req.method === 'GET' && url.pathname === '/v1/runs') {
      const ns = url.searchParams.get('ns');
      if (ns && !may(ns)) return forbidden(ns);
      return json(res, 200, { runs: store.runs({ ns }).filter((r) => may(r.ns)) });
    }
    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'runs' && parts.length >= 5) {
      const run = { ns: parts[2], wf: parts[3], run: parts[4] };
      if (!may(run.ns)) return forbidden(run.ns);
      const { events, heads } = store.read(run);
      if (!events.length) return json(res, 404, { error: 'no such run' });
      if (parts[5] === 'verify') return json(res, 200, verifyBundle({ events, heads, trust: trustFor(run.ns), allowOpen: url.searchParams.get('allowOpen') === '1' }));
      if (parts[5] === 'report') return text(res, 200, runReport(events, heads, trustFor(run.ns)), 'text/markdown; charset=utf-8');
      return json(res, 200, { events, heads });
    }
    if (req.method === 'GET' && url.pathname === '/v1/evidence') {
      const ns = url.searchParams.get('ns');
      if (!ns) return json(res, 400, { error: 'ns required' });
      if (!may(ns)) return forbidden(ns);
      const period = parsePeriod(url.searchParams.get('from'), url.searchParams.get('to'));
      if (period.error) return json(res, 400, { error: period.error });
      return json(res, 200, evidencePack({ store, ns, from: period.from, to: period.to, trust: trustFor(ns) }));
    }
    if (req.method === 'GET' && url.pathname === '/v1/alerts') return json(res, 200, { alerts: store.alerts().filter((a) => may(a.ns)) });
    if (req.method === 'GET' && isMetrics) {
      const c = store.governanceCounts();
      const alerts = store.alerts();
      const byKind = {};
      for (const a of alerts) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
      const rows = (list, keys) => list.filter((r) => may(r.ns)).map((r) => ({ labels: Object.fromEntries(['ns', ...keys].map((k) => [k, r[k] ?? ''])), value: r.n }));
      return text(res, 200, [
        ...family('polyflow_ledger_deltas', 'counter', 'Deltas accepted by this process.', [{ value: metrics.deltas }]),
        ...family('polyflow_ledger_received_events', 'counter', 'Events written by this process.', [{ value: metrics.events }]),
        ...family('polyflow_ledger_refused', 'counter', 'Deltas refused by this process (malformed, bad head, or a full hold-back buffer).', [{ value: metrics.refused }]),
        ...family('polyflow_ledger_events', 'counter', 'Events held, by kind.', rows(c.events, ['kind'])),
        ...family('polyflow_ledger_pending_deltas', 'gauge', 'Deltas held back until the hole before them fills.', [{ value: store.pendingCount() }]),
        ...family('polyflow_tamper_alerts', 'gauge', 'Alerts held: conflicts, forks and gaps.', [{ value: alerts.length }]),
        ...family('polyflow_alerts', 'gauge', 'Alerts held, by kind.', Object.entries(byKind).sort().map(([kind, value]) => ({ labels: { kind }, value }))),
        ...family('polyflow_verdicts', 'counter', 'Verdicts recorded, by rule and outcome (one per rule a verdict names; rule "" when it names none).', rows(c.verdicts, ['rule', 'outcome'])),
        ...family('polyflow_escalations', 'counter', 'Escalations recorded, by the role asked to decide.', rows(c.escalations, ['role'])),
        ...family('polyflow_human_decisions', 'counter', 'Decisions a person recorded on an escalation.', rows(c.decisions, ['decision'])),
        ...family('polyflow_budget_denials', 'counter', 'Effects denied because a budget was exhausted, by budget rule.', rows(c.budgetDenials, ['rule'])),
        ...family('polyflow_admissions', 'counter', 'Executions admitted, by level.', rows(c.admissions, ['level'])),
        ...family('polyflow_closures', 'counter', 'Executions closed, by outcome.', rows(c.closures, ['outcome'])),
        ...family('polyflow_poisoned', 'counter', 'Runs whose ledger records a poisoned step.', rows(c.poisoned, [])),
        '# EOF', '',
      ].join('\n'), 'application/openmetrics-text; version=1.0.0; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const rows = store.runs().filter((r) => may(r.ns)).slice(0, 200).map((r) => {
        const { events, heads } = store.read(r);
        const v = verifyBundle({ events, heads, trust: trustFor(r.ns), allowOpen: true });
        return `<tr><td>${esc(r.ns)}</td><td>${esc(r.wf)}</td><td>${r.events}</td><td>${v.ok ? '✔ verified' : `✖ ${esc(v.problems[0] ?? v.verdict)}`}</td></tr>`;
      });
      const alerts = store.alerts().filter((a) => may(a.ns)).length;
      return text(res, 200, `<!doctype html><meta charset="utf-8"><title>Polyflow ledger</title><style>body{font:14px system-ui;margin:24px}td,th{padding:4px 10px;border-bottom:1px solid #ddd;text-align:left}</style><h1>Governed runs</h1><p>${alerts} alert(s). Read-only; every figure here is also in the API.</p><table><tr><th>namespace</th><th>workflow</th><th>events</th><th>record</th></tr>${rows.join('')}</table>`, 'text/html; charset=utf-8');
    }
    return json(res, 404, { error: 'not found' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!err.status) console.error(`[polyflow-service] ${req.method} ${req.url}: ${err?.stack ?? err}`);
      json(res, err.status ?? 500, { error: err.status ? err.message : 'internal error' });
    });
  });
  // A slow or idle client cannot hold a connection open (SEC-SV3).
  server.requestTimeout = timeouts.requestMs;
  server.headersTimeout = timeouts.headersMs;
  server.keepAliveTimeout = timeouts.keepAliveMs;
  server.maxHeadersCount = 100;
  return { server, metrics };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A sink for the Temporal plugin that ships each delta to the service.
 *
 * A delta the service holds back (202) is delivered: the service applies it
 * when the hole fills. A refusal that can clear by itself — a full hold-back
 * buffer (409 gap), a 5xx, a 429, the network — is retried with backoff,
 * `retries` times; a conflict or fork (409 with `conflicts`) is returned, for
 * the exporter to report; anything else (401, 403, 422) throws at once.
 */
export function httpSink({ url, token, fetch: doFetch = globalThis.fetch, retries = 5, backoffMs = 100, maxBackoffMs = 2000, sleep: wait = sleep }) {
  // No `head`: many workers write to one service, so continuity is the
  // service's check, not something one worker can know.
  return {
    kind: 'http',
    async write(events, signedHead) {
      let last;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt) await wait(Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - 1)));
        let res;
        let r;
        try {
          res = await doFetch(`${url}/v1/ledger`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ events, signedHead }) });
          r = await res.json().catch(() => ({}));
        } catch (err) {
          last = new Error(`service unreachable: ${err?.message}`);
          continue;
        }
        if (res.status === 200 || res.status === 202) return r;
        if (res.status === 409 && r.conflicts?.length) return r;
        last = new Error(`service refused the delta (${res.status}): ${r.error}`);
        if (!(res.status === 409 || res.status === 429 || res.status >= 500)) throw last;
      }
      throw new Error(`${last.message}; gave up after ${retries + 1} attempts`);
    },
  };
}
