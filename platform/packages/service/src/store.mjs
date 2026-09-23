// The service's store — node:sqlite, append-only. Technical spec §11.
//
// One writer per file, like polyrun's SQLite store; the Postgres store the
// spec names for many writers takes the same interface (P9). Events are keyed
// (ns, wf, run, seq): a second write of the same event is a no-op, and a
// second write of a DIFFERENT event at the same key is never applied — it is
// recorded as a tamper alert, because two different histories for one run is
// what tampering, or a split brain, looks like.
//
// A delta is applied whole or not at all (review SV6): one conflicting event,
// or a first new event that does not chain from the held head (a fork), and
// nothing of it is stored. So the held events of a run are always one
// contiguous chain from seq 0, and its head is simply the highest seq.
//
// Deltas arrive out of order (review SL): two activities scheduled in one
// workflow task carry consecutive deltas, and nothing orders their execution.
// A delta that starts past the held head is held back in `pf_pending`
// (bounded) and applied when the hole before it fills. A hole that stays open
// longer than `gapAfterMs` is reported as a `gap` alert: a reported state, not
// a refusal.
//
// The hold-back buffer is shared, so it is rationed (P9 security review
// SEC-SV1): a quota of deltas and bytes per namespace, and per token, so one
// tenant cannot fill the room another tenant's out-of-order deltas need. A
// held-back delta expires after `expireAfterMs` into a stored `gap` alert, and
// a run that has held-back deltas but no seq 0 after `noStartGraceMs` takes no
// more: a run nobody ever starts cannot hold space.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { genesis } from '@cognitive-fab/polyflow-kernel';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pf_event (
  ns TEXT NOT NULL, wf TEXT NOT NULL, run TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL, at INTEGER NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (ns, wf, run, seq)
);
CREATE TABLE IF NOT EXISTS pf_head (
  ns TEXT NOT NULL, wf TEXT NOT NULL, run TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL,
  key_id TEXT NOT NULL, sig TEXT NOT NULL, body TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (ns, wf, run, seq, key_id)
);
CREATE TABLE IF NOT EXISTS pf_alert (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT, wf TEXT, run TEXT, seq INTEGER,
  held_hash TEXT, offered_hash TEXT, offered TEXT, received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pf_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT NOT NULL, wf TEXT NOT NULL, run TEXT NOT NULL,
  first_seq INTEGER NOT NULL, last_hash TEXT NOT NULL, events TEXT NOT NULL, head TEXT, received_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0, token TEXT,
  UNIQUE (ns, wf, run, first_seq, last_hash)
);
CREATE TABLE IF NOT EXISTS pf_certificate (
  digest TEXT PRIMARY KEY, machine TEXT NOT NULL, build_id TEXT NOT NULL, body TEXT NOT NULL, received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pf_certificate_ns (
  digest TEXT NOT NULL, ns TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (digest, ns)
);
CREATE INDEX IF NOT EXISTS pf_event_kind ON pf_event (ns, kind);
CREATE INDEX IF NOT EXISTS pf_pending_run ON pf_pending (ns, wf, run, first_seq);
CREATE INDEX IF NOT EXISTS pf_pending_age ON pf_pending (received_at);
`;

export class Store {
  /**
   * @param {string} path  a SQLite file, or ':memory:'
   * @param {object} [o]
   * @param {() => number} [o.now]
   * @param {number} [o.gapAfterMs]        a held-back delta older than this is reported as a gap
   * @param {number} [o.maxPendingPerRun]    deltas held back per run before new ones are refused
   * @param {number} [o.maxPending]          deltas held back per NAMESPACE (a quota, not a shared pool)
   * @param {number} [o.maxPendingBytes]     bytes held back per namespace
   * @param {number} [o.maxPendingPerToken]  deltas held back per write token (default: maxPending)
   * @param {number} [o.maxPendingTotal]     deltas held back in all, a last resort against unscoped tokens
   * @param {number} [o.expireAfterMs]       a held-back delta older than this is dropped into a gap alert
   * @param {number} [o.noStartGraceMs]      a run with no seq 0 by then takes no more held-back deltas
   */
  constructor(path = ':memory:', {
    now = Date.now, gapAfterMs = 5 * 60_000, maxPendingPerRun = 256, maxPending = 4096, maxPendingBytes = 64 * 1024 * 1024,
    maxPendingPerToken = maxPending, maxPendingTotal = 65_536, expireAfterMs = 4 * gapAfterMs, noStartGraceMs = 60_000,
  } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    // Stores created before alerts had kinds: every alert they hold is a conflict.
    if (!this.db.prepare('PRAGMA table_info(pf_alert)').all().some((c) => c.name === 'kind')) {
      this.db.exec("ALTER TABLE pf_alert ADD COLUMN kind TEXT NOT NULL DEFAULT 'conflict'");
    }
    const pendingCols = this.db.prepare('PRAGMA table_info(pf_pending)').all().map((c) => c.name);
    if (!pendingCols.includes('bytes')) this.db.exec('ALTER TABLE pf_pending ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0');
    if (!pendingCols.includes('token')) this.db.exec('ALTER TABLE pf_pending ADD COLUMN token TEXT');
    this.now = now;
    this.limits = { gapAfterMs, maxPendingPerRun, maxPending, maxPendingBytes, maxPendingPerToken, maxPendingTotal, expireAfterMs, noStartGraceMs };
  }

  close() { this.db.close(); }

  /**
   * Append a delta (the caller has checked that it chains internally, and any
   * signed head). Never overwrites, never stores a partial delta.
   * @returns {{written:number, skipped:number, conflicts:number[], pending:number, applied:number, refused?:string}}
   *   `pending`: events held back until the hole before them fills; `applied`:
   *   events of earlier held-back deltas this write let through; `refused`: the
   *   hold-back quota is used up, try again.
   * @param {object} [o]
   * @param {string} [o.token]  who is writing: the per-token hold-back quota is charged to it
   */
  writeEvents(events, signedHead = null, { token = null } = {}) {
    const at = this.now();
    this.db.exec('BEGIN');
    try {
      this.#expire(at);
      const r = this.#apply(events, signedHead, at, { holdBack: true, token });
      r.applied = 0;
      if (r.written) r.applied = this.#drain(events[0].run, at);
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  #apply(events, signedHead, at, { holdBack, token = null }) {
    const run = events[0].run;
    const held = this.head(run);
    const next = held ? held.seq + 1 : 0;
    if (events[0].seq > next) {
      if (!holdBack) return { written: 0, skipped: 0, conflicts: [], pending: 0 };
      return this.#holdBack(events, signedHead, at, held, token);
    }
    const get = this.db.prepare('SELECT hash FROM pf_event WHERE ns = ? AND wf = ? AND run = ? AND seq = ?');
    const conflicts = [];
    for (const e of events) {
      if (e.seq >= next) break;
      const h = get.get(run.ns, run.wf, run.run, e.seq);
      if (h.hash !== e.hash) { this.#alert('conflict', run, e.seq, h.hash, e.hash, e, at); conflicts.push(e.seq); }
    }
    const fresh = events.filter((e) => e.seq >= next);
    // Matching held events chain the rest; a delta that starts exactly at the
    // hole must itself point at the held head (or at genesis).
    if (!conflicts.length && fresh.length) {
      const want = held ? held.hash : genesis(run);
      if (fresh[0].prev !== want) { this.#alert('fork', run, fresh[0].seq, want, fresh[0].hash, fresh[0], at); conflicts.push(fresh[0].seq); }
    }
    if (conflicts.length) return { written: 0, skipped: 0, conflicts, pending: 0 };
    const put = this.db.prepare('INSERT INTO pf_event (ns, wf, run, seq, kind, at, hash, body, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const e of fresh) put.run(run.ns, run.wf, run.run, e.seq, e.kind, e.at, e.hash, JSON.stringify(e), at);
    // A head is kept only when it names an event now held, with that hash —
    // and so only for a run whose seq 0 is held: held events are contiguous
    // from 0 (P9 security review SEC-EX1).
    if (signedHead) {
      const h = get.get(run.ns, run.wf, run.run, signedHead.seq);
      if (h && h.hash === signedHead.hash) {
        this.db.prepare('INSERT OR IGNORE INTO pf_head (ns, wf, run, seq, hash, key_id, sig, body, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(run.ns, run.wf, run.run, signedHead.seq, signedHead.hash, signedHead.keyId, signedHead.sig, JSON.stringify(signedHead), at);
      }
    }
    return { written: fresh.length, skipped: events.length - fresh.length, conflicts, pending: 0 };
  }

  #holdBack(events, signedHead, at, held, token) {
    const run = events[0].run;
    const L = this.limits;
    const count = (where, ...args) => this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b, MIN(received_at) AS first FROM pf_pending WHERE ${where}`).get(...args);
    const body = JSON.stringify(events);
    const bytes = Buffer.byteLength(body);
    const perRun = count('ns = ? AND wf = ? AND run = ?', run.ns, run.wf, run.run);
    const perNs = count('ns = ?', run.ns);
    const perToken = token === null ? { n: 0 } : count('token = ?', token);
    const total = count('1 = 1');
    let why = null;
    if (!held && perRun.first !== null && Number(perRun.first) <= at - L.noStartGraceMs) why = `no seq 0 of this run arrived within ${L.noStartGraceMs} ms`;
    else if (Number(perRun.n) >= L.maxPendingPerRun) why = "the run's hold-back quota is used up";
    else if (Number(perNs.n) >= L.maxPending || Number(perNs.b) + bytes > L.maxPendingBytes) why = `namespace '${run.ns}' has used its hold-back quota`;
    else if (Number(perToken.n) >= L.maxPendingPerToken) why = 'this token has used its hold-back quota';
    else if (Number(total.n) >= L.maxPendingTotal) why = 'the hold-back buffer is full';
    if (why) {
      // Refused, so the sender retries; recorded once, so an operator sees the hole.
      const seen = this.db.prepare("SELECT 1 FROM pf_alert WHERE kind = 'gap' AND ns = ? AND wf = ? AND run = ? AND seq = ? AND offered_hash = ?")
        .get(run.ns, run.wf, run.run, events[0].seq, events.at(-1).hash);
      if (!seen) this.#alert('gap', run, events[0].seq, held?.hash ?? null, events.at(-1).hash, { first: events[0].seq, reason: why }, at);
      return { written: 0, skipped: 0, conflicts: [], pending: 0, refused: `gap: the service holds through seq ${held ? held.seq : -1} and cannot hold this delta back: ${why}` };
    }
    this.db.prepare('INSERT OR IGNORE INTO pf_pending (ns, wf, run, first_seq, last_hash, events, head, received_at, bytes, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run.ns, run.wf, run.run, events[0].seq, events.at(-1).hash, body, signedHead ? JSON.stringify(signedHead) : null, at, bytes, token);
    return { written: 0, skipped: 0, conflicts: [], pending: events.length };
  }

  #expireNow() {
    this.db.exec('BEGIN');
    try { this.#expire(this.now()); this.db.exec('COMMIT'); } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /** Drop held-back deltas older than `expireAfterMs`: each run's hole becomes one stored gap alert. */
  #expire(at) {
    const cutoff = at - this.limits.expireAfterMs;
    const old = this.db.prepare('SELECT ns, wf, run, MIN(first_seq) AS first, COUNT(*) AS n FROM pf_pending WHERE received_at <= ? GROUP BY ns, wf, run').all(cutoff);
    for (const g of old) {
      const h = this.head(g);
      this.#alert('gap', g, h ? h.seq + 1 : 0, h?.hash ?? null, null, { first: Number(g.first), dropped: Number(g.n), reason: 'held-back deltas expired: the hole before them never filled' }, at);
    }
    if (old.length) this.db.prepare('DELETE FROM pf_pending WHERE received_at <= ?').run(cutoff);
  }

  /** Apply held-back deltas the held chain now reaches. Returns the events written. */
  #drain(run, at) {
    const pick = this.db.prepare('SELECT id, events, head FROM pf_pending WHERE ns = ? AND wf = ? AND run = ? AND first_seq <= ? ORDER BY first_seq, id LIMIT 1');
    const drop = this.db.prepare('DELETE FROM pf_pending WHERE id = ?');
    let applied = 0;
    for (;;) {
      const h = this.head(run);
      const row = pick.get(run.ns, run.wf, run.run, h ? h.seq + 1 : 0);
      if (!row) return applied;
      drop.run(row.id);
      applied += this.#apply(JSON.parse(row.events), row.head ? JSON.parse(row.head) : null, at, { holdBack: false }).written;
    }
  }

  #alert(kind, run, seq, held, offered, body, at) {
    this.db.prepare('INSERT INTO pf_alert (kind, ns, wf, run, seq, held_hash, offered_hash, offered, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(kind, run.ns, run.wf, run.run, seq, held, offered, JSON.stringify(body), at);
  }

  /** The highest seq held for a run, with its hash. Held events are contiguous from 0. */
  head(run) {
    const r = this.db.prepare('SELECT seq, hash FROM pf_event WHERE ns = ? AND wf = ? AND run = ? ORDER BY seq DESC LIMIT 1').get(run.ns, run.wf, run.run);
    return r ? { seq: Number(r.seq), hash: r.hash } : null;
  }

  read(run) {
    const events = this.db.prepare('SELECT body FROM pf_event WHERE ns = ? AND wf = ? AND run = ? ORDER BY seq').all(run.ns, run.wf, run.run).map((r) => JSON.parse(r.body));
    const heads = this.db.prepare('SELECT body FROM pf_head WHERE ns = ? AND wf = ? AND run = ? ORDER BY seq, key_id').all(run.ns, run.wf, run.run).map((r) => JSON.parse(r.body));
    return { events, heads };
  }

  runs({ ns = null } = {}) {
    const q = ns
      ? this.db.prepare('SELECT ns, wf, run, COUNT(*) AS events, MAX(at) AS last FROM pf_event WHERE ns = ? GROUP BY ns, wf, run ORDER BY last DESC, wf, run').all(ns)
      : this.db.prepare('SELECT ns, wf, run, COUNT(*) AS events, MAX(at) AS last FROM pf_event GROUP BY ns, wf, run ORDER BY last DESC, ns, wf, run').all();
    return q.map((r) => ({ ns: r.ns, wf: r.wf, run: r.run, events: Number(r.events), last: Number(r.last) }));
  }

  /** Every event of some kinds in a namespace and period, for the evidence pack. */
  eventsOfKind(ns, kinds, from, to) {
    const marks = kinds.map(() => '?').join(',');
    return this.db.prepare(`SELECT body FROM pf_event WHERE ns = ? AND kind IN (${marks}) AND at >= ? AND at < ? ORDER BY wf, run, seq`).all(ns, ...kinds, from, to).map((r) => JSON.parse(r.body));
  }

  /**
   * Tamper alerts (`conflict`, `fork`), and gaps: a hole in front of a
   * held-back delta that has stayed open longer than `gapAfterMs`, or a delta
   * refused because the hold-back buffer was full.
   */
  alerts() {
    this.#expireNow();
    const stored = this.db.prepare('SELECT kind, ns, wf, run, seq, held_hash, offered_hash, received_at FROM pf_alert ORDER BY id').all()
      .map((a) => ({ kind: a.kind, ns: a.ns, wf: a.wf, run: a.run, seq: Number(a.seq), held: a.held_hash, offered: a.offered_hash, at: Number(a.received_at) }));
    const cutoff = this.now() - this.limits.gapAfterMs;
    const gaps = this.db.prepare('SELECT ns, wf, run, MIN(first_seq) AS first, MIN(received_at) AS at FROM pf_pending WHERE received_at <= ? GROUP BY ns, wf, run ORDER BY at, ns, wf, run').all(cutoff)
      .map((g) => {
        const h = this.head(g);
        return { kind: 'gap', ns: g.ns, wf: g.wf, run: g.run, seq: h ? h.seq + 1 : 0, through: Number(g.first) - 1, held: h?.hash ?? null, offered: null, at: Number(g.at) };
      });
    return [...stored, ...gaps];
  }

  /** Deltas held back, waiting for the hole before them to fill. */
  pendingCount() {
    this.#expireNow();
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM pf_pending').get().n);
  }

  /**
   * Governance counts derived from the held ledgers (FR-OBS.2), so they
   * survive a restart. Each row carries `ns` and its labels, and `n`.
   */
  governanceCounts() {
    const rows = (sql) => this.db.prepare(sql).all().map((r) => ({ ...r, n: Number(r.n) }));
    return {
      events: rows('SELECT ns, kind, COUNT(*) AS n FROM pf_event GROUP BY ns, kind ORDER BY ns, kind'),
      verdicts: rows(`SELECT e.ns AS ns, COALESCE(j.value, '') AS rule, json_extract(e.body, '$.body.outcome') AS outcome, COUNT(*) AS n
        FROM pf_event e LEFT JOIN json_each(e.body, '$.body.rules') j WHERE e.kind = 'verdict' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`),
      escalations: rows(`SELECT ns, COALESCE(json_extract(body, '$.body.role'), '') AS role, COUNT(*) AS n
        FROM pf_event WHERE kind = 'verdict' AND json_extract(body, '$.body.outcome') = 'escalated' GROUP BY 1, 2 ORDER BY 1, 2`),
      decisions: rows(`SELECT ns, COALESCE(json_extract(body, '$.body.action'), '') AS decision, COUNT(*) AS n
        FROM pf_event WHERE kind = 'proposal' AND json_extract(body, '$.body.source') = 'human' GROUP BY 1, 2 ORDER BY 1, 2`),
      budgetDenials: rows(`SELECT e.ns AS ns, json_extract(j.value, '$.id') AS rule, COUNT(*) AS n
        FROM pf_event e, json_each(e.body, '$.body.witness.rules') j
        WHERE e.kind = 'verdict' AND json_extract(e.body, '$.body.outcome') = 'denied' AND json_extract(j.value, '$.type') = 'budget'
        GROUP BY 1, 2 ORDER BY 1, 2`),
      admissions: rows(`SELECT ns, COALESCE(json_extract(body, '$.body.level'), '') AS level, COUNT(*) AS n
        FROM pf_event WHERE kind = 'admission' GROUP BY 1, 2 ORDER BY 1, 2`),
      closures: rows(`SELECT ns, COALESCE(json_extract(body, '$.body.outcome'), '') AS outcome, COUNT(*) AS n
        FROM pf_event WHERE kind = 'closure' GROUP BY 1, 2 ORDER BY 1, 2`),
      // A run is counted once however many of its events say it was poisoned.
      poisoned: rows(`SELECT ns, COUNT(DISTINCT wf || char(0) || run) AS n FROM pf_event
        WHERE json_extract(body, '$.body.outcome') = 'poisoned' OR json_extract(body, '$.body.stepKind') = 'poisoned' OR json_extract(body, '$.body.poisoned') IS NOT NULL
        GROUP BY ns ORDER BY ns`),
    };
  }

  /** Register a certificate for a namespace: it is in force there from now on. */
  putCertificate(cert, ns) {
    const at = this.now();
    this.db.prepare('INSERT OR IGNORE INTO pf_certificate (digest, machine, build_id, body, received_at) VALUES (?, ?, ?, ?, ?)')
      .run(cert.digest, cert.subject.machine, cert.buildId, JSON.stringify(cert), at);
    this.db.prepare('INSERT OR IGNORE INTO pf_certificate_ns (digest, ns, received_at) VALUES (?, ?, ?)').run(cert.digest, ns, at);
  }

  /**
   * Certificates registered for a namespace before `to` (every one, when no
   * namespace is given), plus any whose build id `buildIds` names.
   */
  certificates({ ns = null, to = Number.MAX_SAFE_INTEGER, buildIds = [] } = {}) {
    if (ns === null) return this.db.prepare('SELECT body FROM pf_certificate ORDER BY received_at, digest').all().map((r) => JSON.parse(r.body));
    const marks = buildIds.map(() => '?').join(',');
    const byId = buildIds.length ? ` OR c.build_id IN (${marks})` : '';
    return this.db.prepare(`SELECT DISTINCT c.body AS body, c.received_at AS at, c.digest AS digest FROM pf_certificate c
      LEFT JOIN pf_certificate_ns n ON n.digest = c.digest AND n.ns = ?
      WHERE (n.ns IS NOT NULL AND n.received_at < ?)${byId} ORDER BY at, digest`).all(ns, to, ...buildIds).map((r) => JSON.parse(r.body));
  }
}
