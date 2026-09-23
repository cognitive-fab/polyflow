// The Jev observation activity — FR-JEV.1–.3; technical spec §9.1.
//
// A machine asks for an observation by ordering an effect whose descriptor
// tool names `activity: "polyflow.observe"` and whose payload names a
// battery declared in the machine's `observations.json` (a certified
// artefact). This activity asks Jev once, maps each answer through its
// declared bands, and returns only facts that cleared a band. The result is
// recorded in Temporal's history like any activity result, so a replay reads
// the recorded facts and never calls Jev again: Jev's answers jitter, and a
// replay must not.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBattery, jevRequest, factsFrom, digest, redactOutbound } from '@cognitive-fab/polyflow-kernel';

export const OBSERVE_ACTIVITY = 'polyflow.observe';
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

/** Load and validate every battery a machine directory declares. */
export function loadBatteries(dir, { allowIllustrative = false } = {}) {
  const f = join(dir, 'observations.json');
  if (!existsSync(f)) return {};
  const raw = JSON.parse(readFileSync(f, 'utf-8'));
  return Object.fromEntries(Object.entries(raw.batteries ?? {}).map(([name, b]) => [name, parseBattery({ name, ...b }, { allowIllustrative })]));
}

/**
 * What may leave the machine (polyx-jev JF0.1; P6-P8 review JV5): only the
 * fields the battery declares as its `source`, and every string in them with
 * secrets and card numbers redacted. A battery with no declared source sends
 * the state as given, redacted; admission refuses such a battery.
 */
export function projection(battery, state) {
  const picked = Array.isArray(battery.source)
    ? Object.fromEntries(battery.source.filter((k) => state?.[k] !== undefined).map((k) => [k, state[k]]))
    : (state ?? {});
  const walk = (v) => (typeof v === 'string' ? redactOutbound(v)
    : Array.isArray(v) ? v.map(walk)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(picked);
}

/**
 * @param {object} o
 * @param {Record<string, Record<string, object>>} o.batteries  machine -> battery name -> parsed battery
 * @param {string} [o.url]
 * @param {string} [o.key]      TYPESAFE_API_KEY
 * @param {string} [o.model]
 * @param {typeof fetch} [o.fetch]  injectable, for tests and proxies
 */
export function jevActivities({ batteries, url = JEV_URL, key = process.env.TYPESAFE_API_KEY, model = 'jev-latest', fetch: doFetch = globalThis.fetch }) {
  return {
    async [OBSERVE_ACTIVITY](payload = {}, meta = {}) {
      // Only a governed run asks the judge, on the operator's API key (P9 security SEC-JV1).
      const { Context } = await import('@temporalio/activity');
      let type = null;
      try { type = Context.current().info.workflowType; } catch { /* called outside an activity: tests */ }
      if (type && type !== 'GovernedWorkflow') {
        const { ApplicationFailure } = await import('@temporalio/common');
        throw ApplicationFailure.nonRetryable(`polyflow.observe serves governed runs only, not '${type}'`, 'PolyflowUnknownBattery');
      }
      const machine = meta.machine;
      const battery = batteries?.[machine]?.[payload.battery];
      if (!battery) {
        const { ApplicationFailure } = await import('@temporalio/common');
        throw ApplicationFailure.nonRetryable(`machine '${machine}' declares no battery '${payload.battery}'`, 'PolyflowUnknownBattery');
      }
      // The battery's own model: it is what the calibration was measured on (review JV3).
      const body = jevRequest(battery, projection(battery, payload.state ?? {}), battery.model ?? model);
      const t0 = Date.now();
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Jev answered ${res.status}`); // retryable: Temporal retries per the manifest
      const answer = await res.json();
      const { facts, abstained, malformed, inert, p } = factsFrom(battery, answer.answers ?? {});
      // The rounded probabilities are kept beside the facts: numbers, not
      // customer text, and what a calibration audit compares with human labels (FR-JEV.5).
      return { facts, abstained, malformed, inert, p, model: body.model, battery: battery.name, version: battery.version, rawDigest: digest(answer.answers ?? {}), latencyMs: Date.now() - t0 };
    },
  };
}
