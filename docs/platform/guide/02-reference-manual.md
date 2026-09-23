# Polyflow for Temporal — reference manual

This manual describes what the code does, option by option. Where it and the
specifications disagree, this manual follows the code. The
[getting-started guide](01-getting-started.md) is the narrative version.

Contents

1. [The TypeScript plugin](#1-the-typescript-plugin)
2. [Policies](#2-policies)
3. [Machine directories](#3-machine-directories)
4. [A governed run: queries, Updates and Signals](#4-a-governed-run-queries-updates-and-signals)
5. [The `polyflow` CLI](#5-the-polyflow-cli)
6. [The MCP gateway](#6-the-mcp-gateway)
7. [The governance service](#7-the-governance-service)
8. [Python](#8-python)
9. [The ledger](#9-the-ledger)
10. [Verified principals](#10-verified-principals)
11. [Versioning](#11-versioning)
12. [Levels at a glance](#12-levels-at-a-glance)

---

## 1. The TypeScript plugin

Package `@cognitive-fab/polyflow-temporal`. Exports:

- `PolyflowPlugin`, `exporter`, `loadMachineDir`
- sinks: `fileSink`, `memorySink`, `runPaths`, `readJsonl`
- signing: `generateSigningKey`, `signHead`, `verifyHead`, `headMessage`, `signPrincipal`
- verification: `verifyBundle`, `verifyThread`, `ledgerFromHistory`
- runs: `startGoverned`, `workflowIdFor`
- certificates: `artefactFiles`, `artefactDigests`, `signCertificate`, `verifyCertificate`, `checkMachineDir`, `CERTIFICATE_FILE`
- versioning: `vet`
- judgement: `jevActivities`, `loadBatteries`, `OBSERVE_ACTIVITY`
- telemetry: `spanAttributes`
- constants: `LEDGER_HEADER` (`polyflow-ledger`), `HEAD_HEADER` (`polyflow-ledger-head`), `FLUSH_ACTIVITY` (`polyflow.flush`)

Workflow-side exports come from `@cognitive-fab/polyflow-temporal/workflows`
(section 4).

### 1.1 `new PolyflowPlugin(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `level` | `'observe' \| 'guard'` | `'observe'` | G0 or G1. G2 and G3 are switched on by `machines`, `trust` and `gate`, not by a level. `'guard'` without `policy` throws. |
| `policy` | policy object | `null` | Admitted in the worker process. At level `guard`, an omitted `unlabelled` is enforced as `'deny'`. |
| `sink` | `fileSink(dir)`, `memorySink()`, `httpSink(...)`, or any `{ write, head? }` | `null` | Where the ledger goes. Without a sink nothing is exported; the history still carries the ledger. |
| `signingKey` | `{ keyId, privateKeyPem }` | `null` | The deployment key. The exporter signs the head of each delta it verified. |
| `memo` | boolean | `false` | Also write the chain head to the workflow memo at close. Not a billable Action, but a history event. |
| `machines` | `{ name: dir }` | `{}` | G2: machine directories to bundle. The descriptor's `name` must equal the key. |
| `trust` | `{ keyId: publicKeyPem }` | `null` | Certificate trust store. Required with `machines` unless `allowUncertified`. Each machine's files must match its signed certificate. |
| `allowUncertified` | boolean | `false` | Development only. Prints a warning at start. |
| `gate` | `{ client, principalKey?, principalId?, namespace? }` | `null` | Registers the gate activities (section 11). With `principalKey`, the gate signs its own Updates as an `operator`. |
| `jev` | `{ url?, key?, model?, fetch?, allowIllustrative? }` | `null` | Registers `polyflow.observe`. Required when any machine has `observations.json`. |
| `externalMode` | `'never' \| 'allowed' \| 'always'` | `'never'` | Whether governed orders may be performed outside the worker (through the gateway). `never` refuses a start with `mode: 'external'`; `allowed` takes the caller's `mode`; `always` makes every run external. |
| `principals` | `{ keyId: publicKey }` | `null` | Verified principals (section 10). With it set, every state-changing Update or Signal needs a signed, action-bound token. |
| `audience` | string | the run's namespace | The `aud` tokens must carry. |
| `headerKey` | `{ keyId, key }` (base64 of 32 bytes) | `null` | Seals ledger and hand-over headers with ChaCha20-Poly1305. Injected into the in-memory bundle at worker start; never written to generated source. |
| `headerKeys` | `{ keyId: key }` | `{}` | Older keys the exporter still opens (rotation). |
| `generatedDir` | path | a private `mkdtemp` per process | Where the generated interceptor module is written (mode 0600). A symlink is refused. |
| `onConflict(run, seqs)` | function | logs | The tamper signal: a sink held a different event at one of these seqs. |
| `onError(err)` | function | logs | Export failures, gaps and forks. The activity is never failed. |
| `onEvents(events)` | function | none | The events this delivery stored, once. For tracers and metrics. |

Refusals at construction: a machine that carries `policy.json` must run at
`level: 'guard'` with that exact policy; a bad `externalMode`; a malformed
`headerKey`; a machine with batteries but no `jev`.

### 1.2 Methods

- `name` → `'polyflow'`.
- `buildId()` → `null` if any machine is uncertified; the certificate's `buildId` (`cert-<12 hex>`) for one machine; `certs-<12 hex>` over all of them for several.
- `configureWorker(options)` → appends the interceptor module **last**, adds the exporter as an activity interceptor, and registers `polyflow.flush`, the gate activities (with `gate.client`) and `polyflow.observe` (with `jev`). Under `workerDeploymentOptions.useWorkerVersioning`, `version.buildId` must equal `buildId()`.
- `configureReplayWorker(options)` → the workflow side only.
- `runWorker(worker, next)` → refuses to run if Polyflow is not the last workflow interceptor module. **List `PolyflowPlugin` last in `plugins`.**
- `interceptorModule()` → the generated module's path.
- `bundlerOptions({ bundleContainsHeaderKeys = false, ...options })` → options for `bundleWorkflowCode`. With `headerKey` it throws unless `bundleContainsHeaderKeys: true`; that bundle then contains the key and must be treated as a secret. A pre-built bundle is accepted only if it was built with this plugin's configuration.

### 1.3 Sinks

`fileSink(root)` → `{ kind: 'file', write(events, signedHead), head(run), read(run) }`.

- `write` → `{ written, skipped, conflicts }`. Idempotent on `(run, seq)`. A delta that conflicts with a held event, or does not chain from the held event before it, is refused **whole**; `conflicts` names the seqs.
- `head(run)` → `{ seq, hash }` or `null`.
- `read(run)` → `{ events, heads }`.

`memorySink()` → the same, plus `runs()`.

`httpSink({ url, token, fetch, retries = 5, backoffMs = 100, maxBackoffMs = 2000 })` (from `@cognitive-fab/polyflow-service`) posts `{ events, signedHead }` to `<url>/v1/ledger` with a bearer token. It retries a gap (409 without conflicts), 429, 5xx and network errors with exponential backoff; it throws at once on 401, 403 and 422. It has no `head`: the service checks continuity.

Layout of a file sink: `<root>/<safe(ns)>/<safe(wf)>/<safe(run)>.jsonl` and
`<safe(run)>.heads.jsonl`, where `safe` keeps each UTF-8 byte in
`[A-Za-z0-9_-]` and writes any other byte as `~` plus two upper-case hex
digits.

### 1.4 The exporter

`exporter({ sink, signingKey, onConflict, onError, onEvents, gapWaitMs = 1000, headerKeys })`
is the activity-side interceptor `configureWorker` installs. For every
activity that carries a ledger header it:

1. opens the header (requires a seal when `headerKeys` is configured);
2. refuses a delta that names another workflow, namespace or, at seq 0, another run;
3. verifies the delta's own chain;
4. waits up to `gapWaitMs` for a predecessor still in flight;
5. on a gap or fork, writes the delta unsigned and reports it;
6. otherwise signs the head it verified and writes both.

It never fails the activity.

### 1.5 Signing

- `generateSigningKey(keyId = 'dev')` → `{ keyId, privateKeyPem, publicKeyPem }` (ed25519).
- `signHead(run, head, key)` → `{ run, seq, hash, keyId, alg: 'ed25519', sig }`.
- `verifyHead(signed, trust)` → `{ ok }` or `{ ok: false, reason }`.
- The signed message is `polyflow-head\n<ns>\n<wf>\n<run>\n<seq>\n<hash>`.

### 1.6 `startGoverned(client, options)`

`{ descriptor, input = {}, taskQueue, key?, mode = 'worker', ...startOptions }`.

- The workflow id is `polyflow/<encodeURIComponent(machine)>/<encodeURIComponent(key)>` (`workflowIdFor`).
- The key comes from `descriptor.key.template` over `input`; each `{field}` must be present, non-empty, at most 512 characters, and match its `pattern`. With no template, `key` is required.
- Passing `workflowId`, `workflowIdReusePolicy`, `workflowIdConflictPolicy`, `args` or `taskQueue` in `startOptions` throws `KeyError`.
- Starts `GovernedWorkflow` with `workflowIdConflictPolicy: 'USE_EXISTING'`.
- Returns `{ handle, workflowId, key, status, note? }` with `status` one of `started`, `attached` (already running), `complete`, or `ended` (with `ended: <status>`).

### 1.7 `proposePlan(plan, options)` (workflow code)

An agent may author a plan at run time. `proposePlan` checks it against the
run's policy **from the run's current guard state**, before any step runs.

```js
import { proposePlan } from '@cognitive-fab/polyflow-temporal/workflows';
const v = await proposePlan({ steps: [
  { id: 'ask',  activity: 'ask_approval' },
  { id: 'post', activity: 'slack_send', args: { text }, after: ['ask'] },
] });
```

- Plan shape: `{ steps: [{ id, activity, args?, after?, maxSpend? }] }`; 1–256 steps; at most 64 KB of canonical arguments; unique ids; no cycles.
- A step covered by a metered budget must declare `maxSpend: { <metric>: number }`, or the plan is refused.
- Every execution order is checked, by walking the plan's down-sets under a budget of 20,000 guard evaluations.
- Verdicts: `{ verdict: 'admitted', escalations, statesChecked }`; `{ verdict: 'refused', witness: { order, step, activity, rules, message, allowedNow } }`; `{ verdict: 'bounded', reason }`.
- With `run: true` (default) an admitted plan runs, each step still crossing the guard. The first failure cancels the other steps and is rethrown. `results: { stepId: result }` is added on success.
- Needs a level-`guard` plugin (`PolyflowNoPolicy` otherwise). A malformed plan fails the call with `PolyflowPlanRefused`, never the workflow task.

### 1.8 Telemetry

`spanAttributes(events)` turns stored events into OpenTelemetry span
attributes: `polyflow.run.workflow_id`, `polyflow.run.chain`,
`polyflow.ledger.seq`, `polyflow.ledger.hash`, `polyflow.effect.kind`,
`polyflow.effect.class`, `polyflow.proposal.id`, `polyflow.verdict`,
`polyflow.rules`, `polyflow.level`, `polyflow.policy.digest` and
`polyflow.approval`. Wire it through `onEvents`. It emits attributes only,
not timed spans.

---

## 2. Policies

A policy is JSON. `polyflow policy` admits it; the plugin admits it again at
start.

```json
{
  "policy": "name", "version": 1,
  "effects": { "<activityType>": { "kind": "post", "class": "irreversible", "labels": ["egress"] } },
  "routes":  { "<activityType>": "0.tool_name" },
  "unlabelled": "deny",
  "rules": [ ... ],
  "escalation": { "role": "approver", "timeoutMs": 3600000 }
}
```

| Field | Required | Meaning |
|---|---|---|
| `policy` | yes | A name. |
| `version` | yes | A positive integer. |
| `effects` | yes, non-empty | Activity type (or `type:routeValue`) → `{ kind, class?, labels? }`. `class` is one of `none` (default), `reversible`, `compensable`, `irreversible`. `labels` is a subset of `reads-private`, `reads-untrusted`, `egress`. |
| `routes` | no | Activity type → a dotted path into the argument **list** (`^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$`). The call is classified as `<type>:<value>`. A routed call whose value the policy does not declare is **always denied**. |
| `unlabelled` | no | What happens to an activity `effects` does not name: `report` (allow, and note it), `deny`, `escalate`. The parser's default is `report`; **a guard-level worker enforces `deny` when it is omitted.** |
| `rules` | no | See below. |
| `escalation` | when anything escalates | `{ role = 'approver', timeoutMs = 86400000 }`. |

The admitted form adds `digest`, `kinds` and `notes` (irreversible kinds no
rule guards).

### 2.1 Rules

Common fields: `id` (unique), `type`, `outcome` (`deny` or `escalate`;
default `escalate` for `bind: 'per-effect'`, else `deny`), `forbid: true` to
exempt the guarded kind from the reachability check (required for `at-most`
with `n: 0`).

| type | fields | holds when |
|---|---|---|
| `requires-prior` | `guards`, `prior`, `consume` (default `true`), `bind` (`any` \| `per-effect`) | a `prior` effect **succeeded** before. With `consume`, each success licenses one guarded effect. With `per-effect`, only an approval for this exact call licenses it. |
| `implies-prior` | as above, `consume` default `false` | a `prior` effect was **scheduled** before. |
| `at-most` | `guards`, `n` | fewer than `n` guarded effects have been scheduled in this chain. |
| `never-after` | `guards`, `after: { kind } \| { signal }` | the `after` kind has not been scheduled, or the signal not received. |
| `trifecta` | `declassify?` | for a candidate labelled `egress`: the run has not both read untrusted content and private data since the last `declassify`. A failed untrusted read still taints. |
| `budget` | `metric` (`effects` default, or a metered name), `max`, `kinds?`, `from` (required when metered: a dotted path into the activity result) | `effects`: fewer than `max` effects committed. Metered: the sum read from results is below `max`. A negative reading closes the budget. A budget with no `kinds` also caps unlabelled effects. |
| `rate` | `guards`, `n`, `perMs` | fewer than `n` guarded effects in the sliding window. |

Every failing rule is reported. Any `deny` denies; otherwise escalating rules
escalate. An approval satisfies escalating rules, never a denial. The witness
is `{ rules: [{ id, type, fix }], candidate, counters, sequence, allowedNow }`.

### 2.2 What admission refuses

Missing or empty `policy` or `effects`; a bad version, class, label, route
path or `unlabelled`; a rule with no id, a duplicate id, an unknown type or a
bad outcome; `guards`/`prior` naming an undeclared kind, or the same kind; a
metered budget without `from`; `at-most` with `n: 0` and no `forbid`; a
`never-after` with neither kind nor signal; escalation without an
`escalation` block; and any kind that the rules make unreachable ("kind 'X'
can never be allowed under these rules"). Machine admission (`polyflow admit`)
additionally refuses a `policy.json` with unguarded irreversible kinds.

---

## 3. Machine directories

A G2 machine is a directory. File names are the defaults; the descriptor may
override them (`contract`, `machine`, `effects`, `manifest`,
`effectInvariants`, `invariants`, `migrate`, `policy`, `observations`).

| File | Required | What |
|---|---|---|
| `polyflow.workflow.json` | yes | The descriptor. |
| `contract.json` | yes | State keys, initial state, actions, data domains, terminal states. |
| `machine.cjs` | yes | The SAM v2 strict module. |
| `effects.cjs` | yes | The pure effect mapper. |
| `effects.manifest.json` | yes | Order kinds: completion wiring and retries. |
| `effect-invariants.mjs` | yes | What may never be emitted on any path. |
| `invariants.mjs` | no | What must hold in every reachable state. |
| `migrate.cjs` | for shape changes | `migrate(oldState) → newState`, pure. |
| `policy.json` | no | A policy the machine must run under (forces `level: 'guard'` with that digest). |
| `observations.json` | no | Judge batteries. |
| `polyflow.certificate.json` | written by `admit` | The certificate. |

Local modules `machine.cjs` and `effects.cjs` require are certified too.
Every `require`/`import` must name a literal path, and only
`@cognitive-fab/sam-pattern` and relative files may be required.

### 3.1 `polyflow.workflow.json`

| Field | Default | Meaning |
|---|---|---|
| `name` | required | Must equal the registration key in the plugin and the gateway. |
| `description` | `''` | Shown in the gateway catalogue. |
| `inputAction` | `'START'` | The action stepped with the run's input. |
| `tools` | `{}` | `{ <kind>: { tool?, why?, target?, performer?, role?, activity? } }`. `activity` names the activity to schedule (default: the kind). `performer: 'human'` marks a person's order (role `human` unless `role` says otherwise); such a step must arm a timer. |
| `key` | `null` | `{ template: "{field}", fields: { field: { pattern?, description? } } }`: how the workflow id is derived from the input. |
| `stopAction` | — | The action a person uses to stop the run. Admission requires it to be accepted and terminal from every non-terminal state. |
| `unstoppable` | `{}` | `{ <state value>: "reason" }`: states exempt from the stop check, recorded in the certificate. |
| `noStop` | — | A reason for having no stop action. Without `stopAction` or `noStop`, admission fails. |
| `claimLeaseMs` | `600000` | How long a claim on an order holds. |

### 3.2 `contract.json`

```json
{
  "stateKeys": [{ "name": "briefState", "type": "'idle' | 'gathering' | 'review' | 'posted'" }, { "name": "ticketCount", "type": "number" }],
  "initState": { "briefState": "idle", "ticketCount": 0 },
  "actions": { "START": { "dataFields": {} }, "TICKETS_READY": { "dataFields": { "count": "number" } } },
  "dataDomain": { "TICKETS_READY": { "count": [0, 3] } },
  "terminalKey": "briefState",
  "terminalStates": ["posted", "denied", "failed", "stopped"]
}
```

- The module's state keys must equal `stateKeys` exactly.
- Every action must be exported by the module.
- `dataDomain` is the finite domain admission explores: the machine's own `domain` arrays must cover every combination, or admission refuses. A domain that lists `null` makes an absent field arrive as `null`.
- `checkSnapshot` (used on hand-over, release and migration) checks each value against its `type` where the type is a literal union, `number`, `string`, `boolean`, `null`, an array or an object type.

### 3.3 `machine.cjs`

A SAM v2 strict-profile module exporting `{ instance, init, actions, getState, setState }`.
Actions are `{ action, schema, domain: [ ...data ] }`; acceptors use
`reject`, `next` and `unchanged`. `lastStep()` classifies a step as
`accepted`, `rejected` or `unhandled`. A throw from an action poisons the
run; a `SamSchemaError` is a reject.

### 3.4 `effects.cjs`

`module.exports.effects = (pre, action, data, post, stepKind) => intents`, pure.

- `{ kind, payload }` — an order of a declared kind.
- `{ kind: 'timer', key, fireIn | fireInMs | fireAt, action, data? }` — a timer; keys are unique per step; a terminal step arms none.
- `{ kind: 'cancelTimer', key }`.

An undeclared kind, or a mapper that throws, poisons the run. Order ids are
`sha256(runKey|seq|kind|ordinal)[0:32]`.

### 3.5 `effects.manifest.json`

```json
{ "effects": { "<kind>": {
    "payloadSchema": { "ticketCount": "number" },
    "onSuccess":   { "action": "DRAFT_READY" },
    "onFailure":   { "action": "TICKETS_FAILED" },
    "onExhausted": { "action": "TICKETS_FAILED", "data": { "reason": "api-error" } },
    "retry": { "maxAttempts": 3, "baseMs": 1000, "timeoutMs": 120000, "heartbeatMs": 30000 } } } }
```

`retry.heartbeatMs` (optional) is the activity's heartbeat timeout; an order that parks (a person's) should set it, since it also bounds how soon a cancellation reaches the activity (the SDK throttles heartbeats to 80% of it, 30 s without one).

Completion data: on success the result's fields (a scalar result carries
none); on permanent failure `{ reason: message }`; on exhaustion
`{ reason: 'exhausted' }`. A hook's `data` overrides these; a `map`
(`{ field: "result.x" | "error.message" }`) replaces them. Without
`onFailure`, a permanent failure uses `onExhausted`, and vice versa. Hook
actions must exist in the machine.

### 3.6 Invariants

- `effect-invariants.mjs` exports `effectInvariants: [{ name, pred(path) }]`, where `path` offers `count(kind)`, `emitted[i].{kind, step}`, `actionBefore(action, i)` and `actions[].action`.
- `invariants.mjs` exports `stateInvariants: [{ name, pred(state) }]`.

Both sets of names become the certificate's `guarantees`.

### 3.7 `observations.json`

```json
{ "batteries": { "refund": {
    "model": "jev-2026-06",
    "source": ["message"],
    "questions": { "reason_stated": {
      "type": "noul", "instructions": "…", "criteria": ["…"],
      "assertAt": 0.85, "refuteAt": 0.15,
      "calibration": { "n": 120, "positives": 58, "negatives": 62, "assertPrecision": 0.97, "refutePrecision": 0.95, "model": "jev-2026-06" } } } } } }
```

- Only `noul` questions. `choice` and `score` are refused.
- Bands: `0 ≤ refuteAt < assertAt ≤ 1`, separated by at least 0.02; `refuteAt: -1` means assert only.
- A question is **calibrated** only if `n ≥ 60`, at least 15 of each label, `assertPrecision ≥ 0.9` (and `refutePrecision ≥ 0.9` when it refutes), and `calibration.model` equals the battery's `model`. Otherwise it is inert: it yields no fact. `illustrative: true` is inert unless the worker sets `jev.allowIllustrative`.
- `source` lists the state fields that may be sent. They are redacted before they leave.
- Admission requires `model` and `source`, and checks that every `result.facts.<name>` a manifest reads is produced by some battery.

The `polyflow.observe` activity returns `{ facts, abstained, malformed, inert, p, model, battery, version, rawDigest, latencyMs }`.

---

## 4. A governed run: queries, Updates and Signals

Your workflows module re-exports the governed host:

```js
export * from '@cognitive-fab/polyflow-temporal/workflows';
```

`GovernedWorkflow` takes `{ machine, input = {}, mode = 'worker' | 'external' }`.
Every other field is a Continue-as-New carry and is refused on a fresh start.

| Name | Kind | Arguments | Result |
|---|---|---|---|
| `polyflow.state` | Query | — | `{ machine, certificate, state, seq, terminal, poisoned, orders: [{ orderId, kind, args, tool, target, why, attempt, role, claimedBy?, claimedUntil? }], mode, done, migrationPending, timers }` |
| `polyflow.journal` | Query | — | the last 500 steps: `{ seq, action, data, pre, post, stepKind, rejectReason, actionId, source, at }` |
| `polyflow.propose` | Update | `{ action, data?, actionId?, orderId?, actor? }` | `{ stepKind, reason, state, seq, action }`. The validator dry-runs the step; a rejected proposal never enters history. A completion action needs the open `orderId` it completes, from its holder, with its role. A duplicate `actionId` is answered, not re-stepped. |
| `polyflow.propose` | Signal | same | no validator. Refused when principals are configured. |
| `polyflow.report` | Update | `{ orderId, ok?, result?, error?, permanent?, actor? }` | the step result; `{ stepKind: 'retry', attempt }` for a retryable failure; `{ stepKind: 'unwired' }` when nothing is wired. Only for **external** orders. A claimed order is reported by its holder only. |
| `polyflow.claim` | Update | `{ orderId, actor }` | `{ claimed, holder, orderId, claimedUntil }`. Needs the order's role. |
| `polyflow.release` | Update | `{ snapshot, principal?, reason?, force? }` | `{ state, replayed }`. Only for a quarantined run; the snapshot must pass `checkSnapshot`; a terminal snapshot needs `force`. Held proposals are replayed. |
| `polyflow.migrate` | Update | `{ snapshot, from, toBuildId?, onVersionChange?, shapeChange?, principal? }` | `{ accepted, waitsForVersionChange }`. `from` must be the digest of the current state. Refused when terminal, poisoned, pending, or into a terminal state. |
| `polyflow.version` | Signal | `{ decision, toBuildId?, reason?, principal? }` | recorded in the journal. |
| `polyflow.wake` | Signal | — | an activation, so a run waiting for promotion re-checks its target version. |
| `polyflow.guard` | Query | — | `{ level, policy, guard, at }` — the guard state (any governed worker, not only G2). |
| `polyflow.pending` | Query | — | escalations awaiting a decision: `[{ approvalId, kind, target, argsDigest, args, rules, message, role, requestedAt }]` |
| `polyflow.approve` | Update | `{ approvalId, decision: 'approve' \| 'reject', principal, note?, argsDigest? }` | `{ approvalId, decision }`. A given `argsDigest` must match the parked call. |

Actors: an `actor` is `{ id, roles }` (recorded as unverified) or a signed
token (section 10). Roles: an order addressed to a role is claimed and
reported only by an actor holding it.

During a hand-over (Continue-as-New) every Update is refused with a retryable
reason; retry it and it reaches the next execution.

A poisoned run (a mapper threw, an undeclared kind, a state the machine
cannot hold) is quarantined: it accepts only `stopAction` and
`polyflow.release`, and holds other proposals for replay after release.

---

## 5. The `polyflow` CLI

Package `@cognitive-fab/polyflow-cli`, binary `polyflow`. Exit codes: 0 ok;
1 the thing checked is not ok; 2 usage. Flags take a value (`--trust file`)
or stand alone.

| Command | Flags | What it does |
|---|---|---|
| `verify <run.jsonl>` | `--trust trust.json`, `--allow-open`, `--unsigned`, `--json` | Checks the chain, the signed heads (trusted and anchored, signed through the last event) and the closure. Verdicts: `closed-and-signed`, `open-and-signed`, `consistent-unsigned`, or not ok. |
| `verify --thread <dir>` | `--trust`, `--unsigned`, `--json` | Every chain of a LangGraph thread as one record: one root, resolving links, at most one open chain, effects after allowed verdicts, each observation once. |
| `export <history.json> --out <dir>` | `--header-keys keys.json` | Rebuilds a ledger from a history export's activity headers into a file sink, unsigned. |
| `keygen` | `--id <keyId>` (default `deployment`), `--out <dir>` | Writes `<id>.key.json` (private, 0600) and merges `trust.json`. |
| `policy <policy.json>` | `--out admitted.json` | Admits a policy and prints or writes its admitted form. Does not apply the guard-level `unlabelled` default. |
| `admit <dir>` | `--key key.json`, `--accept-bound "<why>"`, `--json` | Runs every check (domain, observations, check-effects, structural, policy, modules) and writes a certificate. Unsigned without `--key`, which workers with `trust` refuse. |
| `vet --old <dir> --new <dir> --fleet fleet.json` | `--trust`, `--allow-uncertified`, `--allow-empty-fleet`, `--json` | polyvers over each distinct live state (`fleet.json`: `[{ workflowId, state, openKinds? }]`). Per run: `auto-upgrade`, `migrate` (with `to`), or `pin`. The new version must be admitted. |

`admit` and `vet` load the candidate machine's own code in your process. Run
them in CI with no credentials in the environment.

The certificate: `{ v, subject: { workflowType, machine }, artefacts: { name: digest }, guarantees, checks, domains, boundAccepted, toolchain: { polygraph, kernel, 'sam-pattern' }, issuedAt, buildId, signatures, digest }`.
`buildId` depends on what was certified, not on `issuedAt`, so re-admitting
the same commit gives the same version.

---

## 6. The MCP gateway

Package `@cognitive-fab/polyflow-gateway`, binary `polyflow-gateway` (MCP
over stdio). It offers governed runs to any MCP-capable agent through the
same six tools polyflow has always had, plus `workflow_claim`. Runs started
through it are `mode: 'external'`, so workers need `externalMode: 'allowed'`
or `'always'`.

| Variable | Default |
|---|---|
| `POLYFLOW_TEMPORAL_ADDRESS` | `localhost:7233` |
| `POLYFLOW_TEMPORAL_NAMESPACE` | `default` |
| `POLYFLOW_TASK_QUEUE` | `polyflow` |
| `POLYFLOW_MACHINES` | JSON `{ name: dir }` |
| `POLYFLOW_TRUST` | path to `trust.json`. Without it, nothing is admitted. |
| `POLYFLOW_ALLOW_UNCERTIFIED` | `1` to offer uncertified machines (development; marked `uncertified: true`) |
| `POLYFLOW_ACTOR` | JSON `{ id, roles }`: who the gateway speaks for |
| `POLYFLOW_PRINCIPAL_KEY` | path to `{ keyId, privateKeyPem }`: with it, the actor is signed per action (60 s tokens) |

Tools:

| Tool | Arguments | Returns |
|---|---|---|
| `workflow_list` | — | `{ workflows: [{ name, description, area, admitted, uncertified?, guarantees, tools, key }] }` |
| `workflow_start` | `{ workflow, input?, key? }` | a run view (`instanceId`, `status`, `state`, `orders`, `next`), plus `key_note` when a given key was ignored |
| `workflow_report` | `{ order_id, ok?, result?, error?, permanent? }` | the run view after the step |
| `workflow_state` | `{ instance }` | the run view |
| `workflow_signal` | `{ instance, action, data? }` | `{ step_kind, step_seq, reason, ... }` (an out-of-band proposal; a reject is an answer, not an error) |
| `workflow_journal` | `{ instance }` | `{ journal: [...] }` |
| `workflow_claim` | `{ order_id }` | `{ claimed, holder, orderId, claimedUntil }` |

The gateway acts only on instance ids of the form
`polyflow/<machine>/<key>` for machines it offers, and checks the run names
that machine. Infrastructure errors reach the model as `internal error (ref …)`.

Programmatic use: `createGateway({ client, taskQueue, machines, trust, allowUncertified, actor, principalKey, audience, principalTtlMs })` → `{ pf, tools }`.

---

## 7. The governance service

Package `@cognitive-fab/polyflow-service`, binary `polyflow-service`: a
shared sink for many workers, with tamper alerts, verification, reports, an
evidence pack, metrics and a read-only console. SQLite by default.

| Variable | Default |
|---|---|
| `POLYFLOW_SERVICE_DB` | `.polyflow/service.sqlite` |
| `POLYFLOW_SERVICE_HOST` / `POLYFLOW_SERVICE_PORT` | `127.0.0.1` / `7300` |
| `POLYFLOW_SERVICE_TOKENS` | required. Comma-separated `token` (every namespace) or `token=ns1\|ns2`. |
| `POLYFLOW_TRUST` | trust file: flat `{ keyId: pem }` (every namespace) or `{ keyId: { pem, namespaces: [...] \| "*" } }` |
| `POLYFLOW_PUBLIC_METRICS` | `1` serves `/metrics` without a token |

Where a namespace has a trusted key, a run's first delta must carry a signed
head, so a write token alone cannot invent a run.

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/ledger` | `{ events, signedHead? }` → `{ written, skipped, conflicts, pending, applied }`. 202 when held back for a predecessor; 409 on a conflict or a refused gap; 422 when the delta does not chain or the head fails; 413 over 10,000 events or 4 MiB. |
| GET | `/v1/runs?ns=` | `{ runs: [{ ns, wf, run, events, last }] }` |
| GET | `/v1/runs/:ns/:wf/:run` | `{ events, heads }` |
| GET | `/v1/runs/:ns/:wf/:run/verify?allowOpen=1` | the verification report |
| GET | `/v1/runs/:ns/:wf/:run/report` | a Markdown run report |
| GET | `/v1/evidence?ns=&from=&to=` | the evidence pack: runs, policies, certificates, rule counts, oversight, tamper alerts, and a mapping to EU AI Act Art. 12, 13, 14 and 19/26, ISO/IEC 42001 A.6.2.8 and NIST AI RMF MANAGE 2.4, each `holds: true \| false \| null` (`null`: nothing in scope) |
| POST | `/v1/certificates?ns=` | registers a certificate (digest recomputed, signature checked under that namespace's trust) |
| GET | `/v1/alerts` | `{ alerts: [{ kind: 'conflict' \| 'fork' \| 'gap', ns, wf, run, seq, ... }] }` |
| GET | `/metrics` | OpenMetrics: `polyflow_verdicts_total{ns,rule,outcome}`, `polyflow_escalations_total{ns,role}`, `polyflow_human_decisions_total{ns,decision}`, `polyflow_budget_denials_total{ns,rule}`, `polyflow_admissions_total{ns,level}`, `polyflow_closures_total{ns,outcome}`, `polyflow_poisoned_total{ns}`, `polyflow_ledger_events_total{ns,kind}`, plus delta counters and alert gauges |
| GET | `/` | the console |

Auth is `Authorization: Bearer <token>`; a token not granted a namespace gets
403; 50 requests/s per token with a burst of 200, then 429 with `Retry-After`.
Out-of-order deltas are held back (per-namespace and per-token quotas) and
applied when the hole fills; a hole older than five minutes becomes a `gap`
alert.

---

## 8. Python

Package `polyflow-temporal` (Python ≥ 3.10, `temporalio ≥ 1.33`). Extras:
`signing` (ed25519 heads), `openai-agents`, `g2` (the QuickJS sandbox under
wasmtime), `g2-native`, `langgraph`.

### 8.1 `polyflow_temporal.PolyflowPlugin`

```python
PolyflowPlugin(*, level="observe", policy=None, sink=None, signing_key=None,
               on_conflict=None, on_error=None, header_key=None, header_keys=None)
```

- `policy` is the **admitted** JSON from `polyflow policy`. Set `"unlabelled": "deny"` yourself: the Python plugin does not fill in the guard-level default.
- `signing_key` is `{ keyId, privateKeyPem }` and needs the `signing` extra.
- `header_key` / `header_keys` seal headers exactly as TypeScript does.
- Governs activities, local activities, child workflows, external signals and Nexus operations. Escalation is not supported in Python: an escalating rule denies.
- Register with `Worker(client, task_queue=..., workflows=[...], plugins=[PolyflowPlugin(...)])`.

Sinks (`polyflow_temporal.sinks`): `FileSink(root)` and `MemorySink()` with
`write`, `head`, `read`, `runs_of(ns, wf)`; the same on-disk layout as
TypeScript. A Python ledger verifies under `polyflow verify`.

### 8.2 G2 from Python: the QuickJS host

`polyflow_temporal.machine_host.QuickJSMachineHost(machine_dir, engine=None, fuel=200_000_000, ...)`
runs a certified machine's own TypeScript kernel code inside QuickJS, in a
WebAssembly sandbox with no host access and an instruction budget. Methods:
`init`, `step(state, action, data, run_key=, seq=, now=)`, `dry_run`,
`check_snapshot`, `completion_action`, `is_terminal`. `register_machine(name, host)`
makes it reachable from workflow code.

The engine is `wasm` whenever `wasmtime` is installed. The pinned QuickJS
WebAssembly build is fetched on first use from npm and checked against its
sha256 on every load:

```bash
python -m polyflow_temporal.quickjs_engines fetch     # pre-populate the cache (CI, offline hosts)
POLYFLOW_QUICKJS_NO_FETCH=1                            # forbid network fetches
POLYFLOW_QUICKJS_WASM=/path/quickjs.wasm               # use this file
```

There is no Python `GovernedWorkflow` yet: a workflow steps the host itself.

### 8.3 `polyflow_langgraph`

```python
tools = govern(tools, level="guard", policy=admitted, sink=FileSink(root), signing_key=key,
               store=None, ns="langgraph", allow_unthreaded=False, on_conflict=None, on_error=None)
agent = create_react_agent(model, tools, checkpointer=saver)
tools.governor.close(config)                 # end the thread's chain
tools.governor.snapshot(thread)              # { run, head, guard, closed, runs }
verify_thread(sink, thread)                  # { ok, problems, chains, open }
```

- Hooks LangGraph's `ToolNode` tool-call seam. Every tool call is proposal → verdict → effect → observation; a denial is the `ToolMessage` the model reads.
- The chain and the guard state are a per-thread record beside the sink (`<root>/<ns>/<thread>/thread.state.json`, locked). Nothing is read from messages.
- Each call runs only under the decision made for its exact id, name and arguments. A turn with repeated ids is refused whole.
- A re-run of a finished step returns the recorded result; a step that crashed before it was observed re-runs as the same effect.
- Requires a checkpointer and a thread id unless `allow_unthreaded=True`.
- Not guaranteed: at-most-once tool execution (deduplicate on the effect's idempotency key), agent determinism, and escalation to a person.

---

## 9. The ledger

An event: `{ v: 1, run: { ns, wf, run }, seq, kind, at, body, prev, hash }`,
with `hash = sha256(canonical JSON of the event without hash)` (RFC 8785)
and `prev` the previous hash (`genesis(run)` for seq 0). `run.run` is the
execution that started the chain; Continue-as-New keeps it.

| kind | body |
|---|---|
| `admission` | `{ level, policy: { name, version, digest } \| null, execution: { runId, attempt } }` (LangGraph: `execution: { engine, thread, checkpoint }`, `continues?`) |
| `proposal` | `{ source: 'workflow' \| 'signal' \| 'human' \| 'agent', action, dataDigest?, principal?, approvalId?, planDigest?, steps? }` |
| `verdict` | `{ proposal: 'p<seq>', outcome: 'allowed' \| 'denied' \| 'escalated' \| 'accepted' \| 'rejected', rules, witness?, reason?, approval?, approvalId?, role? }` |
| `effect` | `{ id: 'e<seq>', proposal, kind, class, via, activityType, route?, argsDigest, idempotencyKey, approval? }` |
| `observation` | `{ effect, ok: true, resultDigest }` or `{ effect, ok: false, error }` (redacted, ≤ 200 chars) |
| `closure` | `{ outcome: 'completed' \| 'failed' \| 'cancelled' \| 'continued-as-new' }` |

Argument and result bodies are never stored, only their digests. Signed
heads (`<run>.heads.jsonl`) are `{ run, seq, hash, keyId, alg, sig }`.

Headers: `polyflow-ledger` on scheduled activities carries `{ events, head }`;
`polyflow-ledger-head` on Continue-as-New carries `{ run, seq, hash, guard }`.
Sealed, a header is `{ polyflowSealed: 2, alg: 'chacha20-poly1305', keyId, purpose, runId, seq, nonce, ct }`.

---

## 10. Verified principals

With `principals` configured, whoever approves, reports, claims, proposes,
releases or migrates presents a token signed for that one action:

```js
signPrincipal({ id, roles, aud, act }, key, { ttlMs = 300000 })
// → { body: { keyId, id, roles, aud, act, iat, exp }, sig }
```

| op | `act` |
|---|---|
| approve | `{ op: 'approve', wf, run, ref: approvalId, decision, argsDigest }` |
| report | `{ op: 'report', wf, ref: orderId, attempt, digest: digest({ ok, result, error, permanent }) }` |
| claim | `{ op: 'claim', wf, ref: orderId }` |
| propose | `{ op: 'propose', wf, ref: action, digest: digest(data) }` (Update only) |
| release | `{ op: 'release', wf, run, to: digest(snapshot) }` (role `operator`) |
| migrate | `{ op: 'migrate', wf, run, ref: digest(from), to: digest(snapshot) }` (role `operator` or `migrator`) |
| version | `{ op: 'version', wf }` (role `operator`) |

Limits: known fields only; a canonical body of at most 2 KB; a lifetime of at
most 15 minutes; `aud` must equal the worker's `audience` (default: the
namespace). The workflow verifies the signature itself. A token copied from
history can only repeat the action it already recorded.

---

## 11. Versioning

- `plugin.buildId()` is the Worker Versioning build id; `configureWorker` refuses any other.
- `PolyflowGateWorkflow({ machine, oldDir, newDir, toBuildId, fromBuildId, onVersionChange, allowEmptyFleet, apply, phase })`:
  - `phase: 'vet'` (default): reads the fleet (runs on `fromBuildId`), vets each distinct state with polyvers, and applies the decisions. With `onVersionChange: true` a run that moves is told and waits. It fails with `PolyflowGateRefused` on any `pin`, on an empty fleet without `allowEmptyFleet`, or when the new version is not admitted.
  - `phase: 'wake'`: after promotion, signals the waiting runs; each continues as new onto the new version with `AUTO_UPGRADE`, carrying its state, open orders, claims and guard.
- A migration names the state it was computed from; if the run has moved on, the migration is dropped at the hand-over and the gate re-vets. A shape change is checked by the new version, which quarantines a state it cannot hold.
- `PolyflowPolicyGateWorkflow({ oldPolicy, newPolicy, query, allowEmptyFleet })` vets a G1 policy change: it reads each running workflow's `polyflow.guard`, carries spent budgets to renamed rules, and refuses the ramp if any run would be denied an activity it may call now, if a run cannot be read, or if the fleet is empty.

---

## 12. Levels at a glance

| Level | Switch it on | You supply |
|---|---|---|
| G0 | `new PolyflowPlugin({ sink, signingKey })`, listed last | a sink; a key and trust store for signatures |
| G1 | `level: 'guard', policy` | a policy; approvers for escalating rules; optionally `principals`, `headerKey`, `proposePlan` |
| G2 | `machines: { name: dir }` plus `trust` (or `allowUncertified`); re-export the workflows module; `startGoverned` or the gateway | a machine directory; an activity per order kind, or external performers; `jev` for batteries |
| G3 | `polyflow admit --key` in CI; `trust` on workers, gateway and service; `buildId()` as the deployment version; `gate: { client }` and the gate workflows | a CI step; `migrate.cjs` for shape changes; a ramp gate before promotion |
