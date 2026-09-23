# Licensing

Polyflow for Temporal is **source-available, not open source**, and this
document says exactly which parts are under which licence and why. The words
matter: the Business Source License is not OSI-approved, and nothing here
calls it open source.

## What is under which licence

| Component | Licence | Where |
|---|---|---|
| The kernel — canonical JSON, the hash-chained ledger, ed25519, the rule kernel, plan and policy admission, the machine host, the explorer | **Apache-2.0** | `packages/kernel` |
| The verifier — `verifyBundle`, `verifyThread`, the file and memory sinks, signed heads, rebuilding a ledger from a Temporal history, the header names | **Apache-2.0** | `packages/verify` |
| The Temporal plugin, the governed workflow host, the version and policy gates, `vet`, certificates | **BUSL 1.1**, converting to Apache-2.0 four years after each version is published | `packages/temporal`, `LICENSE` there |
| The `polyflow` command (`admit`, `vet`, `policy`; its `verify`, `export` and `keygen` are thin calls into the Apache-2.0 verifier) | **BUSL 1.1** | `packages/cli` |
| The MCP gateway and the governance service | **BUSL 1.1** | `packages/gateway`, `packages/service` |
| The Python plugin (`polyflow_temporal`) and the LangGraph binding (`polyflow_langgraph`) | **BUSL 1.1** | `python/` |
| The ports of Temporal's official samples, and the pinned upstream copies | **MIT** (Temporal Technologies Inc.) | `examples/temporal_samples/*`, `examples/upstream/*`, with a `NOTICE.md` in each port |
| `polyflow` itself — the SAM v2 workflow runtime and MCP server at the repository root | **Apache-2.0** | the repository root; on npm as `@cognitive-fab/polyflow` |

## The BUSL grant

Each BUSL package's `LICENSE` is the Business Source License 1.1 with four
parameters filled in. The one that matters day to day is the **Additional
Use Grant**: you may make production use of the Licensed Work within your own
organisation, on Temporal namespaces (self-hosted or a cloud subscription)
your organisation operates or subscribes to, for your own agents and staff.
What it does not permit is offering the Licensed Work to third parties on a
hosted, embedded or managed basis, or operating, certifying or governing
workflows or agents as a paid service for others.

Four years after a version is published it becomes Apache-2.0 automatically.
That is what the licence says about what happens if the licensor disappears,
and it is in writing rather than in an escrow agreement.

For terms other than the Additional Use Grant: licensing@cognitivefab.com.

## Why the verifier is Apache-2.0

The platform's central claim is that the record it produces can be checked by
anyone: a customer's security team, an auditor, a regulator, Temporal itself.
That claim is only credible if checking needs no licence conversation. So the
verifier, the sinks it reads and the kernel it rests on are Apache-2.0, in
their own packages. Nothing in them governs anything: they read a ledger a
worker wrote (or rebuild it from a Temporal history), check the chain and the
signed heads, and say whether the record is consistent, closed and signed.

The split is real rather than declared. `packages/verify` and
`packages/kernel` import nothing from the BUSL packages; the dependency runs
one way, and the `polyflow` command's `verify` and `export` are calls into
the Apache half.

## Why source-available rather than a binary

The plugin runs on the customer's workers, inside their Temporal namespace,
next to their agents' code. Nothing else was ever going to work: a bank's
workers are not going to load an obfuscated bundle into the same process as
their workflows, and the product's own argument ("here is exactly what runs
on your worker, and here is the record it produces") would be gone. The
licence does the enforcing instead of the compiler.

## Rules that follow from this

**Nothing that went out under Apache-2.0 is ever relicensed.** The kernel,
the verifier and `polyflow` itself stay Apache-2.0. New code may start under
BUSL; existing open code does not move.

**This is not called open source.** BUSL is not OSI-approved. The accurate
words are *source-available*, with an Apache-2.0 kernel and verifier.

**Third-party attribution still applies.** `NOTICE` carries the attribution
for the MIT samples and the Apache-2.0 and MIT dependencies; the licence
audit is at `../docs/platform/reviews/P9-licence-audit.md`.

**Contributions.** A contributor's work enters this repository under the same
terms as the rest of it.
