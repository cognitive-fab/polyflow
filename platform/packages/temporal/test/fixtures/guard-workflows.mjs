// Agent-shaped workflows for the G1 guard tests. Like agent-workflows.mjs they
// know nothing about Polyflow's internals; they only handle a denial the way
// an agent handles any tool error: read it and try something else.
import { proxyActivities } from '@temporalio/workflow';

const acts = proxyActivities({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } });

const denialOf = (err) => {
  const f = err?.type === 'PolyflowDenied' ? err : err?.cause?.type === 'PolyflowDenied' ? err.cause : null;
  return f ? { message: f.message, witness: f.details?.[0] ?? null } : null;
};

/** Posts without asking. Under the policy the post is refused and the workflow sees why. */
export async function naivePoster({ text }) {
  try {
    return { posted: await acts.slack_send({ text }) };
  } catch (err) {
    const d = denialOf(err);
    if (!d) throw err;
    return { denied: d.message, rules: d.witness.rules.map((r) => r.id), allowedNow: d.witness.allowedNow };
  }
}

/** A scripted agent loop: on a denial it reads the witness and does what it says is allowed. */
export async function replanningAgent({ text }) {
  const log = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      log.push(await acts.slack_send({ text }));
      return log;
    } catch (err) {
      const d = denialOf(err);
      if (!d) throw err;
      log.push(`denied:${d.witness.rules[0].id}`);
      if (d.witness.allowedNow.includes('approval')) log.push(await acts.ask_approval({ text }));
      else return log;
    }
  }
  return log;
}

/** Sends each email; per-effect approval rules make each one wait for a human. */
export async function emailer({ emails }) {
  const out = [];
  for (const e of emails) {
    try {
      out.push(await acts.send_email(e));
    } catch (err) {
      const d = denialOf(err);
      if (!d) throw err;
      out.push(`denied:${d.message}`);
    }
  }
  return out;
}

/** Reads a web page, reads the CRM, then mails the result: the lethal trifecta. */
export async function trifecta({ url, to }) {
  const page = await acts.fetch_url({ url });
  const customer = await acts.read_crm({ id: 'c-1' });
  try {
    return await acts.send_email({ to, body: `${page}/${customer}` });
  } catch (err) {
    const d = denialOf(err);
    if (!d) throw err;
    return `denied:${d.message}`;
  }
}
