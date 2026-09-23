// Calibrated observations — FR-JEV.1–.5; technical spec §9.1.
//
// Jev (typesafe.ai SystemOne) answers typed questions about a state with a
// probability. It never answers with text, and its answers jitter by ±0.01
// between identical calls (measured in jev-lab, polyx-jev spec §3), so a Jev
// answer is not a pure function of its input: it is recorded once, as an
// activity result, and every replay reads the record.
//
// A battery of questions is a declared, certified artefact
// (`observations.json` beside the machine). Each question maps a probability
// to one of three results — true, false, or NOTHING — through bands derived
// from a calibration record. The middle band is the model saying it does not
// know, and the machine's contract decides what "unknown" does (typically:
// escalate to a person). A question with no calibration is inert: it produces
// no fact, ever (polyx-jev JF3.1).
//
// `choice` questions are refused: measured, a `choice` over multi-intent text
// returns one label at 0.98–1.00 and silently drops the others (JT2). A
// battery of `noul` questions recovers them at no extra cost. `score` is
// refused too: Jev answers a score with an expectation over the levels (1.99),
// not a level, and there is no calibrated band over it yet (P6-P8 review JV2).
//
// "Calibrated" is checked, not assumed (polyx-jev JF3.2–3.5; review JV3):
//   - a labelled sample of at least 60 items, at least 15 of each label;
//   - assert precision of at least 0.90 (and refute precision, when the
//     question refutes at all);
//   - the calibration names the Jev model it was measured on, and it must be
//     the battery's model: a new model is a new calibration;
//   - a sample marked `illustrative` is not a calibration, unless the caller
//     explicitly allows it (development only).
// A question that fails any of these is inert: it yields no fact.
//
// An answer outside [0, 1] is MALFORMED (a proxy, a vendor bug, percentages):
// it yields no fact and is listed apart from abstentions (review JV1).

export class BatteryError extends Error {
  constructor(problems) { super(`observation battery refused:\n  - ${problems.join('\n  - ')}`); this.name = 'BatteryError'; this.problems = problems; }
}

const NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Validate a battery: { name, version, questions: { key: { type, instructions, fact,
 *   assertAt, refuteAt, calibration: { n, positives, negatives, assertPrecision?, refutePrecision? } } } }
 */
export const CALIBRATION = Object.freeze({ minItems: 60, minPerLabel: 15, minPrecision: 0.9, minSeparation: 0.02 });

/** Why a calibration record does not make a question calibrated, or null. */
function calibrationProblem(c, q, model, { allowIllustrative }) {
  if (!c || typeof c !== 'object') return 'no calibration record';
  if (!Number.isInteger(c.n) || c.n < CALIBRATION.minItems) return `the sample has ${c.n ?? 0} items; at least ${CALIBRATION.minItems} are needed`;
  if (!Number.isInteger(c.positives) || !Number.isInteger(c.negatives) || c.positives < CALIBRATION.minPerLabel || c.negatives < CALIBRATION.minPerLabel) {
    return `the sample needs at least ${CALIBRATION.minPerLabel} items of each label (has ${c.positives ?? 0} positive, ${c.negatives ?? 0} negative)`;
  }
  if (c.positives + c.negatives > c.n) return 'more labels than items';
  if (!(c.assertPrecision >= CALIBRATION.minPrecision)) return `assert precision ${c.assertPrecision ?? 'unknown'} is below ${CALIBRATION.minPrecision}`;
  if (q.refuteAt >= 0 && !(c.refutePrecision >= CALIBRATION.minPrecision)) return `refute precision ${c.refutePrecision ?? 'unknown'} is below ${CALIBRATION.minPrecision}`;
  if (model && c.model !== model) return `calibrated on model '${c.model ?? 'unnamed'}', but the battery asks '${model}': recalibrate`;
  if (c.illustrative && !allowIllustrative) return 'the sample is marked illustrative: it is not a calibration';
  return null;
}

export function parseBattery(raw, { allowIllustrative = false } = {}) {
  const problems = [];
  if (!raw || typeof raw !== 'object') throw new BatteryError(['a battery is an object']);
  if (typeof raw.name !== 'string' || !raw.name) problems.push('`name` is required');
  const questions = {};
  for (const [key, q] of Object.entries(raw.questions ?? {})) {
    const where = `questions.${key}`;
    if (!NAME.test(key)) problems.push(`${where}: key must match ${NAME}`);
    if (q?.type === 'choice') { problems.push(`${where}: 'choice' is refused — it drops secondary intents silently; ask one 'noul' question per intent`); continue; }
    if (q?.type === 'score') { problems.push(`${where}: 'score' is refused — Jev answers it with an expectation, not a level, and it has no calibrated band; ask one 'noul' question per level`); continue; }
    if (q?.type !== 'noul') { problems.push(`${where}: type must be 'noul'`); continue; }
    if (typeof q.instructions !== 'string' || !q.instructions) problems.push(`${where}: instructions are required`);
    const fact = q.fact ?? `obs.${key}`;
    if (!fact.startsWith('obs.')) problems.push(`${where}: an observed fact is named obs.<name>, got '${fact}'`);
    const out = { type: q.type, instructions: q.instructions, fact };
    if (!Number.isFinite(q.assertAt) || !Number.isFinite(q.refuteAt)) problems.push(`${where}: assertAt and refuteAt are required`);
    else if (!(q.assertAt <= 1 && q.refuteAt < q.assertAt && (q.refuteAt >= 0 || q.refuteAt === -1))) {
      problems.push(`${where}: bands must satisfy 0 <= refuteAt < assertAt <= 1 (refuteAt -1: assert only)`);
    } else if (q.refuteAt >= 0 && q.assertAt - q.refuteAt < CALIBRATION.minSeparation) {
      problems.push(`${where}: the bands are closer than Jev's own jitter (${CALIBRATION.minSeparation})`);
    }
    out.assertAt = q.assertAt;
    out.refuteAt = q.refuteAt;
    if (q.criteria) out.criteria = q.criteria;
    // Inert until calibrated: bands come from a labelled sample, never by hand.
    const why = calibrationProblem(q.calibration, q, raw.model, { allowIllustrative });
    out.calibrated = why === null;
    if (out.calibrated) out.calibration = q.calibration;
    else out.inertBecause = why;
    questions[key] = out;
  }
  if (Object.keys(questions).length === 0 && !problems.length) problems.push('a battery with no questions observes nothing');
  if (problems.length) throw new BatteryError(problems);
  return Object.freeze({ name: raw.name, version: raw.version ?? 1, ...(raw.model ? { model: raw.model } : {}), ...(raw.source ? { source: raw.source } : {}), questions });
}

/** The Jev request body for a battery over a projected state. */
export function jevRequest(battery, state, model = battery.model ?? 'jev-latest') {
  const questions = {};
  for (const [key, q] of Object.entries(battery.questions)) {
    questions[key] = { type: 'noul', instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
  }
  return { state, model, questions };
}

/**
 * Map Jev's answers through the bands. Returns { facts, abstained, malformed, inert, p }:
 * facts holds only what cleared a band; a question in the middle band is
 * listed in `abstained` and contributes NO fact — never a default false. An
 * answer that is not a probability is `malformed`, not an abstention: it is a
 * fault to see. `p` keeps each probability, rounded to 3 places: numbers, not
 * customer text, and what a calibration audit compares with human labels (FR-JEV.5).
 */
export function factsFrom(battery, answers) {
  const facts = {};
  const abstained = [];
  const malformed = [];
  const inert = [];
  const p = {};
  for (const [key, q] of Object.entries(battery.questions)) {
    const name = q.fact.slice(4); // the machine reads obs.<name> as <name>
    if (!q.calibrated) { inert.push(key); continue; }
    const v = answers?.[key]?.noul;
    if (v === undefined || v === null) { abstained.push(key); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) { malformed.push(key); continue; }
    p[key] = Math.round(v * 1000) / 1000;
    if (v >= q.assertAt) facts[name] = true;
    else if (q.refuteAt >= 0 && v <= q.refuteAt) facts[name] = false;
    else abstained.push(key);
  }
  return { facts, abstained, malformed, inert, p };
}
