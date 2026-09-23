#!/usr/bin/env node
// The governance service.
//   POLYFLOW_SERVICE_DB      sqlite file (default ./.polyflow/service.sqlite)
//   POLYFLOW_SERVICE_PORT    default 7300; binds 127.0.0.1 unless POLYFLOW_SERVICE_HOST is set
//   POLYFLOW_SERVICE_TOKENS  comma-separated bearer tokens (required); `token=ns1|ns2`
//                            grants a token only those namespaces
//   POLYFLOW_TRUST           path to trust.json: keyId -> { pem, namespaces: [...] | '*' }, or the
//                            flat keyId -> PEM (every namespace). Without it the service cannot
//                            verify, and refuses, signed heads
//   POLYFLOW_PUBLIC_METRICS  '1' serves /metrics without a token (default: a token is required)
import { readFileSync } from 'node:fs';
import { Store, createService } from '../src/index.mjs';

const env = process.env;
const tokens = (env.POLYFLOW_SERVICE_TOKENS ?? '').split(',').filter(Boolean).map((t) => {
  const i = t.indexOf('=');
  return i < 0 ? t : { token: t.slice(0, i), namespaces: t.slice(i + 1).split('|').filter(Boolean) };
});
if (!tokens.length) { console.error('POLYFLOW_SERVICE_TOKENS is required: the service does not run without authentication'); process.exit(2); }
const store = new Store(env.POLYFLOW_SERVICE_DB ?? '.polyflow/service.sqlite');
const trust = env.POLYFLOW_TRUST ? JSON.parse(readFileSync(env.POLYFLOW_TRUST, 'utf-8')) : {};
if (tokens.some((t) => typeof t !== 'string') && Object.values(trust).some((v) => typeof v === 'string')) {
  console.error('polyflow-service: tokens are scoped to namespaces but POLYFLOW_TRUST has flat entries, which are trusted for EVERY namespace; give each key its namespaces');
}
if (!Object.keys(trust).length) console.error('polyflow-service: no POLYFLOW_TRUST: deltas that carry a signed head will be refused (422), because it cannot be verified');
const { server } = createService({ store, trust, tokens, publicMetrics: env.POLYFLOW_PUBLIC_METRICS === '1' });
server.listen(Number(env.POLYFLOW_SERVICE_PORT ?? 7300), env.POLYFLOW_SERVICE_HOST ?? '127.0.0.1', () => console.error(`polyflow-service listening on ${JSON.stringify(server.address())}`));
