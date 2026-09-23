#!/usr/bin/env node
// MCP stdio server: polyflow's work-order tools over a Temporal namespace.
//
//   POLYFLOW_TEMPORAL_ADDRESS   host:port of the Temporal frontend (default localhost:7233)
//   POLYFLOW_TEMPORAL_NAMESPACE namespace (default "default")
//   POLYFLOW_TASK_QUEUE         where the governed workers poll
//   POLYFLOW_MACHINES           JSON: { "<name>": "<machine dir>" }
//   POLYFLOW_TRUST              path to trust.json; only machines it certifies are admitted
//   POLYFLOW_ALLOW_UNCERTIFIED  '1' (development, without POLYFLOW_TRUST): machines may be started, and the
//                               catalogue marks them uncertified. Without either, nothing can be started.
//   POLYFLOW_ACTOR              optional: JSON { id, roles } — who this gateway speaks for
//   POLYFLOW_PRINCIPAL_KEY      optional: path to JSON { keyId, privateKeyPem }: sign the actor for each
//                               action (short-lived, action-bound), so workflows can verify it
import { readFileSync } from 'node:fs';
import { Client, Connection } from '@temporalio/client';
import { serve } from '@cognitive-fab/polyflow';
import { createGateway, } from '../src/index.mjs';
import { version } from '../src/temporal-polyflow.mjs';

const env = process.env;
const connection = await Connection.connect({ address: env.POLYFLOW_TEMPORAL_ADDRESS ?? 'localhost:7233' });
const client = new Client({ connection, namespace: env.POLYFLOW_TEMPORAL_NAMESPACE ?? 'default' });
const { tools } = createGateway({
  client,
  taskQueue: env.POLYFLOW_TASK_QUEUE ?? 'polyflow',
  machines: JSON.parse(env.POLYFLOW_MACHINES ?? '{}'),
  trust: env.POLYFLOW_TRUST ? JSON.parse(readFileSync(env.POLYFLOW_TRUST, 'utf-8')) : null,
  allowUncertified: env.POLYFLOW_ALLOW_UNCERTIFIED === '1',
  actor: env.POLYFLOW_ACTOR ? JSON.parse(env.POLYFLOW_ACTOR) : null,
  principalKey: env.POLYFLOW_PRINCIPAL_KEY ? JSON.parse(readFileSync(env.POLYFLOW_PRINCIPAL_KEY, 'utf-8')) : null,
});
serve({ name: 'polyflow-gateway', version: version(), tools });
