# Review: P6 (judgement and plans), P7 (Python), P8 (service and evidence), first P9 measurements

This is an adversarial review of:

- calibrated observations (Jev) and plans as proposals:
  `platform/packages/kernel/src/{observe,plan}.mjs`,
  `platform/packages/temporal/src/{jev,plans,governor-registry,otel}.mjs`, and
  the wiring in `workflow-interceptors.mjs`, `governed-workflow.mjs` and `plugin.mjs`
- the example `platform/examples/refund-triage` and its admission tests
- the Python port and plugin: `platform/python/polyflow_temporal/*`, the
  conformance corpora `platform/conformance/*` and their generators
- the governance service: `platform/packages/service/src/*`
- the P9 acceptance tests in `platform/packages/temporal/test/acceptance.test.mjs`

The review checks the code against the functional spec (FR-JEV, FR-PLAN,
FR-OBS, NFR-6/7/13, §6), the technical spec (§3.1, §9–§13), the polyx-jev
integration spec that FR-JEV cites (JF0–JF3), the jev-lab measurements, and
the P6–P9 rows and Status table of the implementation plan. The reviewer did
not write the code and changed no production code.

**The tree moved during the review.** P4/P5 fixes were landing at the same
time (`admit.mjs`, `certificate.mjs`, `workflow-interceptors.mjs`,
`guard-governor.mjs`, `governed-workflow.mjs` and `plugin.mjs` all changed
between 19:13 and 19:25). One probe was fixed while it was being written: a
machine that `require`s `node:https` is now refused (FR-JEV.4). That test was
dropped. Every finding below was re-run against the tree as of 19:30.

## How to reproduce

Each review test asserts what a spec, or the module's own header, claims.
Each one **fails today**, for the reason its message gives.

| File | Tests | Needs server |
|---|---|---|
| `platform/packages/kernel/test/review-p6p8-kernel.test.mjs` | KJ1, KJ2, KJ3, KP1 | no |
| `platform/packages/cli/test/review-p6p8-admit.test.mjs` | JA1, JA2, JA3 | no (about 1 s) |
| `platform/packages/temporal/test/review-p6p8-temporal.test.mjs` (+ `fixtures/review-p6p8-workflows.mjs`) | TP1, TP2, TP3, TJ1 | yes (about 75 s; TP3 waits 60 s for a wedged run, then terminates it) |
| `platform/packages/service/test/review-p6p8-service.test.mjs` | SV1–SV6 | no (in-process HTTP) |
| `platform/python/tests/test_review_p6p8.py` (+ `review_p6p8_workflows.py`) | PYC1, PYS1 (pure); PYR1, PYB1, PYG1, PYX1 (dev server) | partly |

```
cd platform/packages/kernel   && node --no-warnings --test test/review-p6p8-*.test.mjs
cd platform/packages/cli      && node --no-warnings --test test/review-p6p8-*.test.mjs
cd platform/packages/service  && node --no-warnings --test --test-concurrency=1 test/review-p6p8-*.test.mjs
cd platform/packages/temporal && node scripts/test-each.mjs review-p6p8
cd platform/python            && .venv/Scripts/python.exe -m pytest -q tests/test_review_p6p8.py
```

The baseline at review time:

- kernel: 68/68
- service: 5/5
- temporal `judge`, `otel`, `acceptance`: 8/8
- pytest: 19/19
- cli: 17/23. The six failures are the **P4/P5 review tests** (AB1, IN1, DEP1,
  PL1, BV1, SA1), which were still open when P6–P8 were built on top of them.
  See "Process" below.

All 23 review tests fail. No activity is left parked. TP3 terminates the run
it wedges. Temporary machine directories go under `examples/.tmp-review-p6p8-*`
and are removed.

Two probes were run as throwaway scripts rather than committed tests:

- a differential fuzz of canonical JSON: 20,010 random doubles, the ES
  exponent boundaries, lone surrogates and NFC edge cases, TS against Python
- a differential fuzz of the guard: 1,500 random policies × 25 operations,
  covering float meters, rate windows, credits, trifecta, grants and signals

Both are described under "What held up". Their one divergence is PYC1.

---

## Summary

| # | Severity | Finding | Evidence |
|---|---|---|---|
| CD | **blocker** | Admission explores the machine module's own action domain. The certificate records the digest of the *contract's* `dataDomain`, which was never explored. refund-triage's `ASSESSED` domain has 3 of the 9 fact combinations the contract declares. Two plausible bugs are certified with the guarantee `no-refund-unless-the-judge-cleared-it-or-a-person-approved`: reading the fraud question's abstention as "no fraud", and refunding when the judge *refuted* the reason. The model also represents "abstained" as `null`, while the runtime delivers an absent key. | JA1, JA2, code |
| SL | **blocker** | The service sink refuses any delta that arrives ahead of its predecessor (409 gap). The exporter swallows the error and never retries, so every later delta is also a gap. Two activities scheduled in one workflow task (parallel tool calls, and every unordered `proposePlan`) deliver in no fixed order. The first inversion truncates that run's service ledger for good, and says so only in a worker's `console.error`. | SV2 |
| TP3 | major | Plan admission runs inline in the workflow task and enumerates permutations. An agent's two-branch, 14-step plan, after 80 ordinary tool calls, fails every workflow task with "Script execution timed out after 5000ms". The run is wedged, and the agent triggers it. The tech spec says admission runs in an activity. | TP3, measurements |
| PL | major | "Admitted" does not mean the plan runs to the end. Metered budgets are never spent in the check. A failed step leaves the other branches running after `proposePlan` has already thrown to the agent. Nothing records how a plan ended. | KP1, TP1 |
| JV1 | major | A probability outside [0, 1] becomes a fact (`noul: 87` → `true`, `-0.4` → `false`). | KJ1 |
| JV2 | major | `score` questions are accepted but can never produce a fact from a real Jev answer: Jev returns an expectation (1.99), and the code accepts only an integer index. If an integer ever arrived, it would be used with no band. | KJ2, jev-lab `results.json` |
| JV3 | major | "Calibrated" is a presence check. `{ n: 1, positives: 0, negatives: 0 }` counts as calibrated, and so does 40% assert precision. Bands are set by hand. The shipped example's calibration is marked "ILLUSTRATIVE". Calibration is bound to no model id, and FR-JEV.5 cannot be built from the record, because only a digest of the probabilities is kept. | KJ3, code |
| JV4 | major | Admission certifies `observations.json` without parsing it. A `choice` question and inverted bands are certified, and are refused only when a worker with `jev` configured starts. | JA3 |
| JV5 | major | Customer text goes to Jev unredacted (polyx-jev JF0.1). | TJ1 |
| SV1 | major | A "signed head" is stored without checking its signature, its run or its hash. Any token holder can attach a garbage head to *another* run and turn that run's verification to NOT verified. `INSERT OR IGNORE` also lets it squat the slot a real head would take. | SV1 |
| SV6 | major | A forked delta has its conflicting events refused, but its events past the fork are **stored** on top of the real chain. The run can never verify again. The file and memory sinks behave the same way. | SV6 |
| EV | major | The evidence pack is green on nothing. With zero runs (or a non-numeric `from`), Art. 12 and ISO 42001 A.6.2.8 "hold". Art. 14 "holds" when every escalation timed out with nobody deciding. Certificates are not scoped to the namespace or the period. | SV3, SV4, code |
| SV5 | major | The certificate registry checks the signature over `cert.digest` and never recomputes the digest, so an edited body (added guarantees) is registered and shown in the evidence pack. | SV5 |
| PY1 | major | The Python guard governs only activities and local activities. A child workflow (and an external signal, and Nexus) is neither recorded nor decided: a `deny`-by-default policy lets the child run. | PYG1 |
| PY2 | major | Python records failure text unredacted. A credential in an upstream error reaches the ledger. | PYR1 |
| PY3 | major | Python metered budgets are spent only by a `dict` result. A dataclass or pydantic result (the normal case in Python) spends nothing: $5 against a $1 budget, and the next call still runs. | PYB1 |
| PY4 | major | The Python exporter has no continuity check (P0/P1 review E3): it signs any internally consistent delta. The Python FileSink drops a conflicting event silently: no tamper signal. | PYS1, code |
| PY5 | major | The Python plugin writes no closure on workflow cancellation. Guard state resets at every Continue-as-New (review GC, re-opened in Python). | PYX1, code |
| AC | major | The P9 numbers overclaim. S3 is a scripted replay whose "plain" arm names every fire uniquely, not a replication of the FINDINGS-phase3 study with a model. The published 4.5% for NFR-13 is the non-default `memo: false` configuration. The default is 9.1% on the same loop, and any workflow under about 20 Actions exceeds the 10% target. G2's half of NFR-13 is not measured. | acceptance output, code |
| OB | major | FR-OBS.2 metrics are not built: the service exports four ledger counters and none of the verdict, escalation, budget, admission or poisoned-run metrics. FR-OBS.1 spans lack certificate, state, version tuple and `gen_ai.*`. | code |
| — | minor | See the minor list: `onEvents` fires on conflicting and re-delivered deltas; Jev 429/Retry-After, no fetch abort, unverified request shape; battery TOCTOU; plan events not linked to their effects; the `proposal: 'plan'` literal; Python D1 under `workflow_failure_exception_types`; `_pick` diverges on arrays and strings; `cryptography` silently optional; service body errors, O(n) head, console cost, report tie order, OpenMetrics `_total`, token not namespace-scoped. | code, PYC1, TP2 |

---

## Blockers

### CD: admission explores a narrower domain than the certificate claims

`check-effects` (polygraph `polyrun/src/check-effects.mjs:112`) builds its
steps from `domainFromManifest(mod)`, the **machine module's** `domain`
arrays. `admit.mjs:117` writes `domains: digest(contract.dataDomain)` into the
certificate. So the certificate names a domain that nobody explored.

For refund-triage the gap is the judge's whole contribution:

- `contract.json` declares `ASSESSED: { reasonStated: [true,false,null], fraud: [true,false,null] }`, which is 9 combinations.
- `machine.cjs:26` explores 3: `{true,false}`, `{true,true}`, `{null,false}`.

Mutations of the one line that matters (`const clear = …`), each certified
with all three guarantees:

| mutation | what it does at run time | admitted |
|---|---|---|
| `reasonStated === true && fraud !== true` (JA1) | the judge abstains on fraud → **refund on the judge's word** | yes |
| `reasonStated !== null && fraud === false` (JA2) | the judge *refutes* that a reason was given → refund | yes |
| `reasonStated !== false && fraud !== true` (the existing admit test) | abstention on the reason → refund | refused (this combination happens to be in the 3) |

A second, independent gap is in how absence is represented. The model encodes
"the judge abstained" as `null`. At run time, `machine-host.completionAction`
maps a missing fact to `undefined`, and the key disappears from the JSON
payload. A machine that tests `proposal.fraud === null` for abstention is
verified on `null` and receives `undefined`. For example,
`clear = reasonStated === true && fraud !== true && fraud !== null` is
correct in the model and refunds on an abstention in production. It passes
admission today, and would still pass once the domain gap is closed.

**Fix.**

- Explore the contract's `dataDomain`. At the least, refuse admission when a
  module's action domain does not cover it, and certify the domain that was
  actually explored.
- For actions fed by an observation, derive the domain from the battery: each
  fact is `true | false | absent`, with absent encoded **exactly as the host
  delivers it**. Better still, have the host normalise a missing fact to one
  representation before stepping, and explore that representation.
- Add JA1 and JA2 to `admit.test.mjs` as refusals.

### SL: the service sink truncates any run whose deltas arrive out of order

The exporter ships each activity's header delta when that activity *starts*
on a worker. Two activities scheduled in the same workflow task carry
consecutive deltas, and nothing orders their execution: another worker,
another slot, or the network can deliver the second first. `server.mjs:55-56`
answers that with a 409 gap. `httpSink.write` throws. The exporter's `fail`
logs to `console.error` and never fails or retries the activity (by design,
D2). From then on, every later delta of that run is also a gap.

**SV2** delivers the second delta, then the first. The service ends holding 2
of 4 events, and will refuse the rest of the run.

This is not an edge case:

- Parallel tool calls are ordinary in agent loops.
- `proposePlan` starts every unordered step in one task.

The spec positions the service as "the multi-worker sink" (`sink.mjs:40`,
`server.mjs:114-115`).

**Fix.** Make the service accept deltas out of order. Buffer them, or store
them and derive the contiguous verified prefix at read time; the store is
already keyed by seq. Keep "gap" as a *reported* state (a hole older than N
minutes), not a refusal. Independently, give the exporter a bounded retry, or
a reconciliation path from history (`polyflow export`) for a run the service
marks incomplete.

---

## Major

### TP3: a plan can wedge its run

`proposePlan` runs `admitPlan` inline, in the workflow task
(`plans.mjs:30`). `admitPlan` enumerates every linearisation, up to 5,000,
and replays the guard over each one. Every step deep-clones the guard state
twice through `JSON.parse(JSON.stringify(...))`. The cost is orders × steps ×
state size:

| plan | run state | time (Node, this machine) |
|---|---|---|
| 2 chains × 7 (3,432 orders) | fresh | 2.2 s |
| same | 60 prior calls, 8 rate rules | 5.0 s |
| same | 50 approvals granted in the run | 7.6 s |
| same | 100 approvals | 17 s |

On Temporal (TP3), an agent makes 80 ordinary tool calls under a call budget
and eight rate rules, then proposes that plan. Every workflow task attempt
fails with `Script execution timed out after 5000ms` (the TS SDK's
`isolateExecutionTimeout`), and the run never progresses. The agent chose the
plan. The approvals list is never pruned, so the threshold falls as a run
ages.

Tech spec §9.2 and FR-PLAN.2 say admission runs "inside an activity". The
module header claims the inline design is a feature ("admission costs no
activity and replays exactly"). It replays exactly the timeout.

**Fix.**

- Check over the DAG's *down-sets*, not its permutations. Memoise on (steps
  done, guard-state digest). Two chains of 7 have 64 down-sets, not 3,432
  orders.
- Make the bound a declared budget of guard evaluations (FR-PLAN.3 says
  "declared exploration budget"), not of orders.
- If it can still be slow, run it in a local activity as the spec says. The
  verdict then replays from history.

### PL: an admitted plan can stop halfway, and nobody is told how it ended

Plan admission models the run-time guard well for the declarative rules (see
"What held up"). It does not model the things that stop a plan in the
middle, and the executor does not handle them:

- **Metered budgets are never spent in the check.** `admitPlan` observes
  every step with `{ ok: true }` and no `result`, so a `usd` or `tokens`
  budget never moves. **KP1**: three $0.60 model calls around an irreversible
  `publish`, under a $1 budget, are "admitted". At run time the guard stops
  the third call, after the publish.
  FR-PLAN.4 says "with at most the parent's remaining budget".
- **Failures leave orphans.** `Promise.all` rejects on the first failed step.
  The other branches keep running and scheduling their successors after
  `proposePlan` has thrown to the agent. **TP1**: step `a` fails, and the
  agent is told. Step `c` (after the slow `b`) runs anyway, while the agent is
  already re-planning. A human rejection of an escalated step, an escalation
  timeout, a signal that fires a `never-after` rule, or the parent's other
  coroutines spending the budget all end the same way.
- **No outcome is recorded.** The ledger has the plan's `proposal` and
  `verdict`, then ordinary effects. There is no plan-level observation
  (completed / failed at step X / cancelled), and nothing ties an effect to a
  plan step (TP2, minor).

**Fix.**

- Treat a metered budget in a plan as unknown. Either refuse ("this plan's
  cost is not bounded by the budget"), or admit with a declared per-step
  ceiling (`step.maxSpend`) that the check spends and the guard enforces.
- Run each plan in a `CancellationScope`. Cancel it on the first failure, and
  cancel it when the caller stops awaiting.
- Append a plan-level observation with the outcome and the steps that ran.
- Stamp each step's effect with `plan: <digest>, step: <id>`.
- Document "admitted" as "no run-time denial *from the rules* on the success
  path", which is what is checked.

### JV1: an out-of-range probability becomes a fact

`observe.mjs:92-95` checks only `typeof p === 'number' && isFinite(p)`.
**KJ1**: `noul: 87` (a proxy, or a vendor change to percentages) → `fraud: true`.
`noul: -0.4` → `false`. For refund-triage, `reason_stated: 97` with
`fraud_signal: 0` is a judge-cleared refund.

**Fix:** outside `[0, 1]` is malformed. List it in a separate `malformed[]`
(not `abstained`, so a vendor fault is visible), and produce no fact. Also
validate `0 ≤ refuteAt < assertAt ≤ 1` at declaration, allowing JF2.3's
negative assert-only `refuteAt`. Require separation of at least Jev's measured
jitter (0.01, polyx-jev §3).

### JV2: `score` is accepted and inert

jev-lab (`seams.py:106`, `results.json` `polysim.goodwill`) measured a
three-level score answering `1.99, 1.98`: an expectation over levels.
`factsFrom` requires an integer index (`observe.mjs:98`), so **every real
answer abstains** (KJ2). If an integer ever arrived, it would become a fact
with no band and no calibration, which JF2 and JF3 forbid.

**Fix:** refuse `score` at declaration, as `choice` is refused. Or define
bands over the returned expectation, calibrated like `noul`.

### JV3: "calibrated" is a presence check

`observe.mjs:57`: any integer `n ≥ 1` with integer `positives` and `negatives`
counts as calibrated. **KJ3** shows two things. `{ n: 1, positives: 0, negatives: 0 }`
yields facts. So does `assertPrecision: 0.4`.

The header says "bands come from a labelled sample, never by hand". Bands are
`assertAt` and `refuteAt`, typed by hand. JF3.2 (≥ 60 items, ≥ 15 of each
label), JF3.3 (bands derived from the distribution) and JF3.4 (assert
precision ≥ 0.90) are not checked. The shipped `observations.json` carries
`"sample": "ILLUSTRATIVE — replace …"` and passes as calibrated.

Two further gaps:

- **No model binding.** The calibration is bound to no model id. The plugin's
  `model` defaults to `jev-latest`, outside the certificate, so a vendor model
  change silently re-bands every question. polyx-jev's risk table rates this
  "high" and requires recalibration (JF3.5).
- **FR-JEV.5 cannot be built from the record.** Tech spec §9.1 says raw
  answers are "stored by digest for calibration tracking". A digest of
  probabilities cannot be compared with a human label. Probabilities are
  numbers, not customer text, and are safe to keep.

**Fix:**

- Validate the calibration record per JF3.2–3.4, and make a question inert
  when it fails.
- Check that the bands are consistent with the recorded precision, or store
  the per-label `p` distributions and derive the bands at admission.
- Put the model id in the battery (the certified artefact), and record it in
  every activity result.
- Record the rounded `p` per question in the activity result, beside the
  facts. The history is under the customer's codec already.

### JV4: the battery is certified without being checked

`admit.mjs` never calls `parseBattery`: `observations.json` is digested as an
artefact and that is all. **JA3**: a battery with a `choice` question and
inverted bands (`assertAt: 0.1, refuteAt: 0.9`) is **ADMITTED**. It is
refused only if a worker is started with the `jev` option
(`plugin.mjs:265`). A worker without it certifies nothing about it, and
`polyflow.observe` is then simply unregistered.

The Status row "Jev observation batteries (declared, calibrated,
three-valued, certified)" rests on this.

**Fix:**

- Parse every battery in `admit`.
- Cross-check each `result.facts.<name>` path in the manifest against the
  battery's fact names.
- Refuse a worker that runs a machine declaring batteries without `jev`
  configured.

### JV5: customer text goes to Jev unredacted

`jev.mjs:78-84` posts `payload.state` verbatim. **TJ1**: a message containing
`password=…` and `api_key=sk-live-…` is sent to `api.typesafe.ai` as is. The
kernel's `redact` (the ledger's pattern set) is not applied.

polyx-jev JF0.1 is a standing rule: "no customer text leaves the machine
unredacted; a corpus whose redaction is not declared cannot be annotated".
jev-lab's own sample includes a card number.

**Fix:** redact the projection before the request, with the tenant's pattern
set extended for PANs. Add a declared projection field whitelist to the
battery (JF1.2 "source"), so only named fields leave, and refuse a battery
with no declared source.

### SV1: signed heads are stored unverified, for any run

`store.writeEvents` inserts `signedHead` whenever the delta wrote anything
(`store.mjs:65-69`). It never checks that:

- the head names the delta's run,
- its seq and hash match a held event,
- the signature verifies against the trust store.

**SV1**: a token holder ships a valid delta for its own run, with a head that
names another run, carrying `keyId: 'worker2', sig: 'AAAA'`. The victim run,
closed and signed, now reports NOT verified forever. Because of `INSERT OR
IGNORE` on `(ns, wf, run, seq, key_id)`, a head planted first also blocks the
real one. Tokens are not scoped to a namespace (NFR-8), so any worker can do
this to any tenant's run.

**Fix:** at write time, require `signedHead.run` to equal the delta's run and
`(seq, hash)` to equal an event in the delta. Verify the signature against
`trust`, and refuse with 422 otherwise. Scope tokens to namespaces.

### SV6: a fork's continuation is stored on top of the real chain

`writeEvents` loops per event. It records a conflict for each held seq that
differs, and **inserts** every seq it does not hold, even when that event
chains from a conflicting one.

**SV6**: the real run holds seq 0–2. A delta forks at seq 1 and carries 1–3.
The service raises two alerts and stores the forger's seq 3 after the real
seq 2, so the stored chain is permanently broken. The file and memory sinks
(`sink.mjs:68-74`, `103-108`) do the same. The exporter declines to *sign*
such a delta, but still writes it.

**Fix:** treat a delta atomically. If any event conflicts, refuse the whole
delta (alert, write nothing). If the first new event's `prev` is not the held
hash at `seq - 1`, it is a fork: refuse it.

### EV: the evidence pack is green on nothing

`evidence.mjs:129-134`:

- **Art. 12 / ISO 42001 A.6.2.8** hold when `notVerified === 0`, which is
  true for **zero runs** (SV3). `from`/`to` go through `Number()`, so
  `?from=abc` is `NaN`, every comparison is false, and the pack is empty and
  green. Doctrine 2: "empty … never green".
- **Art. 14** holds when `decisions === 0`, including when every escalation
  timed out with nobody deciding (SV4). That is the absence of oversight.
- **Art. 13 / certificates**: `store.certificates()` is every certificate
  ever registered, for any namespace, with no notion of "in force" in the
  period.
- Verdict statistics come from every event in the namespace, including runs
  whose chains do not verify.
- Plan verdicts (`accepted`/`rejected`) are silently dropped from `byRule`.
- `runSummary` verifies with `allowOpen: true`, so open runs count as
  "verified".

**Fix:**

- `holds: null` with "no runs in scope" when the scope is empty.
- Validate the period.
- Art. 14 holds only when every escalation has a human decision, *and*
  (per the pack's own disclosure) when those decisions are by verified
  principals.
- Scope certificates by namespace and by the admission events' build ids in
  the period.
- Compute statistics over verified runs only, and report the rest separately.

### SV5: the certificate registry accepts edited certificates

`server.mjs:62-66` calls `verifyCertificate`, which checks the signature over
`polyflow-certificate\n${cert.digest}` (`certificate.mjs:16`). It does not
check `certificateDigest(cert) === cert.digest`, a check that
`checkMachineDir` does make. **SV5**: a signed certificate with an extra
guarantee appended is registered (200). Its forged guarantee appears in the
evidence pack's `certificates`.

**Fix:** recompute the digest in `verifyCertificate` itself, so no caller can
forget to.

### PY1: the Python guard does not see child workflows, signals or Nexus

`plugin.py` overrides `start_activity` and `start_local_activity` only.
**PYG1**: under `unlabelled: deny`, a workflow starts a child workflow
`Courier`. It runs, and the ledger has no proposal for it. The TypeScript
plugin governs `startChildWorkflowExecution`, `signalWorkflow` and
`startNexusOperation` (P2/P3 review G1: "one workflow signalling another is an
obvious way around a policy"). The Python G1 claim in the Status table does
not mention the gap.

**Fix:** override `start_child_workflow`, `signal_external_workflow` and
`start_nexus_operation` with the same `_governed` path, and add the TS guard
tests' Python twins.

### PY2: Python records failure text unredacted

`plugin.py:138`: `str(err.cause or err)[:200]`. **PYR1**: an
`ApplicationError("… api_key=sk-live-…")` lands in the ledger verbatim. The
TS side runs `redact` first (`workflow-interceptors.mjs:64`).

**Fix:** port `redact.mjs` into the kernel port. Pin its patterns and its
truncation marker (`…`) in the conformance corpus, since the observation body
is hashed.

### PY3: Python metered budgets ignore non-dict results

`plugin.py:144` passes `result if isinstance(result, dict) else None`.
**PYB1**: an activity returning `Usage(usd=5.0)` (a dataclass) twice, under a
`usd ≤ 1` budget, runs both. Also, `_pick` (`rules.py:29-37`) walks only
dicts, while the TS `pick` walks any object. **PYC1**: `items.0.n` on
`{items:[{n:2}]}` reads 2 in TS and nothing in Python. From then on, the two
guards' states differ.

**Fix:** convert the result with the SDK's payload converter to JSON-shaped
data before observing it (`to_payload` → `from_payload(..., Any)`, or
`dataclasses.asdict` and pydantic `model_dump`). Make `_pick` index lists by
decimal key and strings by `length`, as TS does. Add both to `guard.json`.

### PY4: the Python exporter and FileSink drop the tamper signals

The exporter (`plugin.py:282-299`) verifies the delta internally, then signs
it. It never compares with the sink's head, so a delta that skips ahead or
forks is signed (the P0/P1 E3 regression). `FileSink.write` keeps only unseen
seqs and returns nothing. **PYS1**: a different event at a held seq is
dropped, with no conflict. The TS sinks return `{conflicts}` and the exporter
calls `onConflict`.

**Fix:** port `sink.head`, the gap and fork logic, and the conflict return.
Share one fixture between the two languages' sink tests.

### PY5: Python closure on cancellation, and Continue-as-New

- **PYX1**: a cancelled workflow's ledger ends at `effect`: no observation
  and no closure. Workflow cancellation arrives as `asyncio.CancelledError`,
  which is neither `FailureError` nor `ContinueAsNewError`
  (`plugin.py:188-199`). The verifier then reports it as "unfinished or
  truncated". The in-flight activity's cancellation is also skipped by
  `observed()` (`plugin.py:137`), so the guard keeps an open effect.
- `_Run(config)` is fresh per execution, so guard state (budgets, `at-most`,
  taint, rate windows) resets at every Continue-as-New. This is the P4/P5
  review's GC. It is fixed in TS at 19:17 (`guardGovernor.restore`), and open
  in Python. The module docstring lists only the missing chain hand-over.

**Fix:**

- Catch `asyncio.CancelledError` in `execute_workflow`. Close with
  `cancelled` under a shielded flush, then re-raise.
- Record `ok: false` (cancelled) for cancelled activities.
- Carry `{run, seq, hash, guard}` in the Continue-as-New headers, as TS now
  does.

### AC: the P9 measurements say more than they show

- **S3.** Functional spec §6 defines S3 as "the double-post class is
  eliminated in the *replicated FINDINGS-phase3 study* on Temporal … published
  with records". FINDINGS-phase3 drove a real model (deepseek-v4-flash)
  through OpenWorker. The S3 test has no model. Its plain arm starts each fire
  under a distinct id (`brief-2026-09-22-fire-${i}`), so it demonstrates
  "derive the id from the input". A plain Temporal workflow with a
  date-derived id and `WorkflowIdReusePolicy.REJECT_DUPLICATE` also posts
  once. The fires run serially, and the retry-after-crash double post (an
  at-least-once activity) is not exercised. Useful as a regression test. It
  is not S3.
- **NFR-13.** The test logs `{"baseline":22,"governed":24,"governedWithoutMemo":23,"pct":4.5}`.
  The 4.5% is `memo: false`. The plugin's default is `memo: true`: 2/22 = 9.1%
  on this 10-step loop. The overhead is a fixed +2 per *execution*, so any
  workflow under about 20 Actions exceeds the 10% target at the default. A
  single-activity workflow pays +200%, and every Continue-as-New pays it
  again.
- Not counted: flush-activity retries (up to 5), queries of
  `polyflow.pending`, and history and storage growth from ledger headers
  (every activity's header carries its delta; this is billed as storage, and
  counts against the 50 MB history limit).
- G2's half of NFR-13 ("vs an equivalent hand-written workflow") is not
  measured.

**Fix:** state S3 as "the re-fire mechanism, scripted". Keep the replication
as open work. Report NFR-13 at the default configuration, with the formula
(+2 per execution), the break-even size, and what is excluded. Or make
`memo: false` the default if the memo is optional.

### OB: FR-OBS.1/.2 are thinner than the Status row says

- **Metrics.** `/metrics` has `polyflow_ledger_{deltas,events,refused}_total`
  and `polyflow_tamper_alerts`. None of tech spec §12's metrics exist:
  `polyflow_verdicts_total{rule,outcome}`, escalations by role, budget used,
  poisoned runs, export lag. No admission or version-gate outcomes. The
  counters are per process and reset on restart.
- **Spans.** `spanAttributes` emits kind, class, proposal, verdict, rules,
  policy digest, and level on the first delta only. There is no
  `polyflow.certificate`, `polyflow.state`, `polyflow.version_tuple` or
  `gen_ai.*`. The "spans" are attribute bags with no timing or parent context.

**Fix:** add the §12 metrics, derived from the verdict events the service
already holds so they survive restarts. State in the Status table that the
OTel adapter emits attributes only.

---

## Minor

- **`onEvents` on bad deltas** (`plugin.mjs:75-78`). It is called after
  `sink.write` whether the write reported conflicts or a gap, and on every
  re-delivery (activity retry). Tracers get spans for forged events, and
  duplicates.
- **Jev transport.**
  - Every non-2xx is a generic retryable `Error`: 401 and 400 are retried,
    and 429's `Retry-After` is ignored (use `ApplicationFailure` with
    `nextRetryDelay`).
  - `fetch` has no `AbortSignal`, so a timed-out attempt keeps its request
    running, and there is no heartbeat for cancellation.
  - The request sends `state` as an object. Every jev-lab call sends a string,
    and no test touches the real endpoint, so the shape is unverified.
  - `res.json()` failures are retried like outages.
- **Battery TOCTOU.** `checkMachineDir` runs in the constructor, and
  `loadBatteries` re-reads `observations.json` later in `configureWorker`.
- **Plan events.** The plan's `proposal` records `digest(args)`, while the
  effect records `argsDigest([args])` (the call's argument array), so they
  never match (TP2). Every plan's verdict says `proposal: 'plan'`, not the
  `p<seq>` its proposal event got, so two plans in one run are ambiguous in
  the ledger and in `spanAttributes` (keyed by proposal).
- **Plan spec gaps.** Only step lists exist: no SAM-module plans, no child
  `GovernedWorkflow`, no ephemeral certificate (§9.2). The `approval?` step
  field is ignored. `maxOrders` is fixed at 5,000 and neither declared nor
  recorded (FR-PLAN.3).
- **Python D1.** A worker configured with `workflow_failure_exception_types`
  turns a plain exception into a workflow failure, and the plugin writes no
  closure for it.
- **Python signing.** `_sign` returns `None` when `cryptography` is not
  importable, and `pyproject.toml` does not declare it. A configured key then
  silently produces an unsigned ledger.
- **Python `start_activity`** returns an `asyncio` Task wrapping the
  `ActivityHandle`, not the handle. Code that relies on the handle type breaks.
- **Python `FileSink`** re-reads the whole events file on every write
  (quadratic), and has no cross-process append discipline.
- **Service body handling.** Malformed JSON is a 500, not a 400. `store.head`
  scans the whole run on every write (quadratic). The console runs
  `verifyBundle` over up to 200 runs per page load.
- **Report determinism.** `store.read` orders heads by `seq` only, so ties
  (two keys, one seq) come out in SQLite's order. `runReport` puts
  `s.run.wf` into Markdown unescaped.
- **OpenMetrics.** A counter's `# TYPE` line names the family without
  `_total` (`# TYPE polyflow_ledger_deltas counter`). Strict OpenMetrics
  parsers reject the current form.
- **`/metrics` is unauthenticated** even when `publicReads` is false. It
  leaks only counts, but it should be a stated choice.

## Nits

- The Jev replay test (`judge-and-plans.test.mjs:73`) is true by construction.
  `configureReplayWorker` registers no activities, so nothing could call Jev.
  A stronger test replays with a `fetch` that throws.
- `forgetGovernor` is not called on Continue-as-New or task failure. It is
  harmless: TR-style probing showed the registry is not shared across
  executions (see below). But the header's reason for keying by run id then
  does not apply.
- `jevActivities` imports `@temporalio/common` dynamically inside the
  activity, only for the unknown-battery error.

## Test gaps (claims without a test)

- **6.3** "child cannot order a kind the parent could not": there is no plan
  child. The kernel test covers "kinds never declared" in `admitPlan` only.
- **FR-JEV.5**, the Nexus `JudgeService`, and the `jev_answers` table: none
  are built. The Status row does not say so.
- **7.3** (OpenAI Agents SDK sample) and **7.4** (QuickJS): not built, as the
  Status row says.
- No Python test covers signals, local activities, Continue-as-New or a
  denial's witness bytes against TS.
- The service has no test with concurrent writers, a head for another run, or
  an empty period.

## Process

The plan's ground rule is: "A phase is not done until its review's findings
are fixed or explicitly deferred." P6–P8 were marked built while the P4/P5
review (4 blockers) was "in progress". Its six CLI tests still fail. Some of
those findings bear directly on these phases:

- **IN/DEP** decide whether a certified judge machine is the code that runs.
- **PL** decides whether the policy that plans are checked against is the
  certified one.

## Status table: what the rows should say

| Row | Says | Should say |
|---|---|---|
| P6 | "batteries (declared, calibrated, three-valued, certified)" | declared and three-valued for `noul`. Calibration is presence-only (JV3), `score` is inert (JV2), and the battery is digested but not validated at admission (JV4). Refund-triage's guarantee holds only over 3 of 9 fact combinations (CD). FR-JEV.5 and the Nexus judge are not built. |
| P6 | "`proposePlan` checks every execution order … against the run's remaining authority" | …for declarative rules on the success path. Metered budgets are not checked, failures leave orphans (PL), large plans wedge the run (TP3), and admission is inline rather than in an activity. No plan children or SAM plans. |
| P7 | "byte-identical … (15 cases); the Python G0/G1 plugin passes on a dev server" | byte-identical on the corpus, and on 20k fuzzed numbers and 1.5k fuzzed guard scripts, except `pick` on arrays and strings (PYC1). G1 covers activities only (PY1). No redaction (PY2), no tamper or continuity checks (PY4), no closure on cancel, and budgets reset on Continue-as-New (PY5). |
| P8 | "sink with tamper alerts and gap refusal, … evidence pack mapped …, OpenMetrics" | the sink truncates runs with parallel activities (SL). Heads are unverified (SV1), forks are partly stored (SV6), the pack is green on empty scopes (EV), the registry accepts edited certificates (SV5), and the metrics are four ledger counters (OB). |
| P9 | "S3 (8 fires, 8 posts plain vs 1 governed) and NFR-13 (… 4.5% on a 10-step loop)" | a scripted re-fire regression, not the S3 replication. NFR-13 at the default is +2 Actions per execution (9.1% on 22 Actions; over 10% below about 20), and G2 is unmeasured. |

---

## What held up

- **Three-valued `noul` mapping.** A missing, non-numeric or mid-band answer
  is abstention, never `false`. An uncalibrated question is inert. The bands
  never leave the worker, and `choice` is refused at declaration.
- **Jev is never on the replay path.** The answer is an activity result. The
  replay worker registers no activities, and no Jev code runs in the isolate.
  With a correct domain, the refund-triage *machine as shipped* treats every
  abstention as "go to a person".
- **Plan admission and concurrency.** Unordered steps run concurrently, and
  concurrency is not literally one of the checked orders: a step is decided
  while its siblings are committed but not yet observed. For every current
  rule type, that intermediate state is dominated by some checked order:
  - `requires-prior` and credits see *less* success, so they deny no more
    than an order that puts the step first, which the check already covers.
  - Taint and metered budgets see less. The runtime guard then allows more,
    but the check has already refused any plan with a bad order.
  - `at-most`, `never-after{kind}`, effect budgets and `rate` read commit-time
    state, which is identical.

  The runtime guard still decides every step, so no execution can break a
  rule. What fails is liveness (PL), not safety. Any new rule type that reads
  observation state must be re-examined against this.
- **Escalations assumed approved** in the check are sound for safety: at run
  time each is a real escalation, bound per effect.
- **Authority attenuation, as built.** The check starts from the run's
  *current* guard state and uses the run's own policy. A plan cannot use a
  kind the policy does not allow, or an effect budget already spent. The
  runtime interceptor, not the plan, decides each step.
- **Plan determinism.** Admission is pure over the guard state and workflow
  time, and a plan replays clean (the existing test runs the Replayer).
- **The governor registry does not leak.** A probe that looked up the previous
  execution's governor after Continue-as-New (with `maxCachedWorkflows: 10`)
  found nothing. Module scope is not shared between executions here.
- **Canonical JSON port.** It matched TS on all 20,010 fuzzed doubles
  (including 5e-324, 1e21, 2^53 + 2 and every exponent boundary), lone
  surrogates, U+2028/9, U+FEFF, NFC and compatibility characters, and astral
  key ordering.
- **Guard port.** Over 1,500 random policies × 25 operations, including float
  meters (0.1 + 0.2), negative meter readings, rate windows with fix strings,
  consuming credits, trifecta with declassify, grants and signals, the Python
  decisions, witness digests and state digests matched TS byte for byte. The
  only divergence is PYC1.
- **Signing format.** The head message (`polyflow-head\n…`) is identical in
  both languages. A Python-signed ledger verifies under the TS CLI.
- **Service basics.**
  - A different event at a held seq is refused and becomes an alert. The held
    record is untouched.
  - Bearer tokens are compared in constant time.
  - Writes need a token. Reads do too, unless `publicReads` is set.
  - Bodies over 4 MB are refused.
  - The console escapes what it prints.
  - Reports are byte-stable for a fixed store.
  - The pack states its limits ("consistency checks, not proofs"), marks
    retention `null`, and counts unverified principals as not verified.
- **Redaction on the TS ledger path.** Failure text is redacted before
  hashing. The Jev result carries only facts, the lists and a digest, with no
  text.

---

## Response

Both blockers and every major are fixed. All the reviewer's failing tests
now pass, and I changed only one of them: KJ2, whose own comment allows
refusing `score` at declaration. The P4/P5 review is answered in full, so
nothing this review found rests on an open finding.

| Suite | Result |
|---|---|
| kernel | 72/72 (KJ1–KJ3 and KP1 included) |
| cli | 26/26 (JA1–JA3 included) |
| service | 17/17 (SV1–SV6 included) |
| temporal (one file per process) | green, including `review-p6p8-temporal` 4/4 (TP1–TP3, TJ1) |
| python | 106 passed (the P6–P8 review tests, the parity tests and the S2 sample included) |

| # | Outcome | What changed |
|---|---|---|
| CD | fixed | Admission has a new `domain` check. Every combination the contract's `dataDomain` declares must be a step the machine explores, or the machine is refused with the missing combinations named. The certificate therefore names the domain that was actually explored. The machine host normalises "absent" to exactly what was explored: a field whose declared domain includes `null` reaches the machine as `null` when the payload leaves it out. refund-triage now explores all 9 fact combinations, and JA1 and JA2 are refused. |
| SL | fixed | The service holds back a delta that arrives ahead of its predecessor (202 `pending`, bounded to 256 per run and 4096 in total) and applies it when the hole fills. A hole older than `gapAfterMs` is a `gap` alert, not a refusal. `httpSink` retries a gap, 429, 5xx or network error with backoff. For sinks that can answer for their head, the exporter waits up to `gapWaitMs` for a late predecessor. |
| TP3 | fixed | `admitPlan` walks the plan's down-sets, memoised on (down-set, guard state), not its linearisations. The bound is a declared budget of guard evaluations. TP3's plan now decides inside one workflow task. Admission stays inline, not in an activity. It is deterministic and now cheap, and putting it in an activity would add a billable Action per plan. The module header says so. |
| PL | fixed | **Metered budgets:** a plan step a metered budget covers must declare `maxSpend`. The check spends that amount, and a plan without it is refused (KP1). **Orphans:** the executor runs the plan in its own `CancellationScope`. The first failure cancels every other step before `proposePlan` throws (TP1). **Outcome:** a plan-level observation records `completed` or `failed`, with `failedAt`, `ran` and `cancelled`. Plan steps name the same argument digest as the effect that carries them out (TP2). The plan verdict names its proposal by seq. "Admitted" is documented as: no denial by the rules on the success path. |
| JV1 | fixed | An answer outside [0, 1] is `malformed`, listed apart from abstentions, and yields no fact. Bands must satisfy 0 ≤ refuteAt < assertAt ≤ 1 (refuteAt −1 means assert-only), and must be separated by at least Jev's jitter (0.02). |
| JV2 | fixed | `score` is refused at declaration, like `choice`, with the reason. |
| JV3 | fixed | "Calibrated" is now checked against JF3.2–3.5: n ≥ 60, at least 15 of each label, assert precision ≥ 0.90 (and refute precision when the question refutes), and a `model` that must equal the battery's `model`. A sample marked `illustrative` is inert unless the worker sets `jev.allowIllustrative`, which is for development only. The shipped example is marked illustrative. The activity result now keeps each probability rounded to three places (`p`), and the model it asked, so FR-JEV.5 can be built from the record. |
| JV4 | fixed | Admission parses every battery. It requires `model` and a declared `source`, and checks every `result.facts.<name>` the manifest reads against the facts the batteries produce. A worker that loads a machine declaring batteries without `jev` configured is refused. |
| JV5 | fixed | Only the battery's declared `source` fields leave the machine. Every string in them passes through `redactOutbound`: the ledger's secret patterns, plus a Luhn-checked card-number pattern, without truncation. The kernel's secret set gains Stripe-style keys, in both languages. |
| SV1 | fixed | A signed head must name the delta's run, match an event of the delta by seq and hash, and verify against the service's trust store. Otherwise the whole delta gets 422. The store keeps a head only if it matches an event it holds. Tokens can be scoped to namespaces. |
| SV6 | fixed | A delta is refused whole, in the service and in the file and memory sinks, if any event conflicts or does not chain. The shared logic is `partitionDelta`. |
| EV | fixed | With nothing in scope, a control reports `holds: null` ("no runs in scope"), not `true`. Art. 14 holds only when every escalation has a human decision by a verified principal. Periods are validated, and certificates are scoped to a namespace and a period. |
| SV5 | fixed | Both the registry and `verifyCertificate` recompute the certificate digest from its body before they check the signature. |
| PY1–PY5 | fixed | Python now governs child workflows, external and child signals, and Nexus. It redacts failure text with a byte-for-byte port of the kernel's patterns. It spends metered budgets from dataclass and pydantic results through the payload converter. It checks continuity in the exporter and gives a tamper signal in `FileSink`. It closes a cancelled run. It carries the head and guard state across Continue-as-New, and decides D1 with the SDK's own failure-type rule. PYC1: `_pick` follows JS property access. New parity vectors pin `pick` and `redact` against TypeScript. |
| AC | fixed in the claim, and in the default | **S3:** the Status table now calls the test what it is, "the re-fire mechanism, scripted". Replicating FINDINGS-phase3 with a model remains open work. **NFR-13:** the memo head is now **opt-in** (`memo: true`). It duplicates what the sink holds, and costs a billable Action per execution. The test reports both settings: +1 Action per execution by default (4.5% on the 22-Action loop, under 10% from 11 Actions), and +2 with the memo (under 10% from 21). It also reports history bytes: the ledger headers **double** the history of that loop (about 5.4 KB per activity, measured as JSON). That is a real cost against the 50 MB cap, and it is recorded as open work (compact header encoding, P9). G2's half of NFR-13 is still unmeasured. |
| OB | fixed (metrics), narrowed (spans) | `/metrics` derives verdicts, escalations, human decisions, budget denials, admissions, closures and ledger events from the stored ledgers, so the counts survive a restart, with OpenMetrics `_total` naming. The ledger has no poison event yet, so `polyflow_poisoned_total` stays at 0 until the governed workflow records one. The Status table now says the OTel adapter emits span **attributes** only. |
| minors | fixed | `onEvents` fires only for events actually stored. Malformed JSON gets a 400. Heads are indexed. Report order is stable. Markdown is escaped. Plans link to their effects. The plan verdict names its proposal. Python D1, `_pick`, and `cryptography` as an explicit extra are all fixed. **Open:** Jev 429 handling with Retry-After and a fetch abort, and the battery time-of-check to time-of-use gap, in P9. |

**Test gaps.** 6.3 (plan children) is still not built. Plans run in the parent
under the parent's guard, which is how FR-PLAN.4's authority ceiling holds, and
the plan says this. FR-JEV.5 is now buildable from the record (`p`), but the
tracking report itself is not built. The service now has tests with a head for
another run, an empty period, and out-of-order writers.

**Process.** Accepted. P6–P8 were marked built while the P4/P5 review was
open. Both reviews are now answered, and the Status table uses the reviewer's
wording where the claim was wider than the evidence.
