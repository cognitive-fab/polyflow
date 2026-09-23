# P9 licence audit

Plan step P9. The audit checks NFR-10: "plugin, CLI, gateway and verifier Apache-2.0; nothing in the Temporal-facing path depends on a non-Apache-compatible component".

Date: 2026-09-22. It covers the tree as installed, not the ranges declared in `package.json`.

## Method

- **npm.** The source is `platform/package-lock.json` (lockfileVersion 3, 177 entries). The audit reads each entry's `license` field. When the lock has none, it reads the installed `node_modules/<pkg>/package.json`. It also checks for a LICENSE, COPYING or NOTICE file on disk.
  - The dependency closure was computed per workspace package using Node's resolution order (nested first, then hoisted), following `dependencies` and `optionalDependencies`.
  - The **Temporal-facing path** is the runtime closure of `kernel`, `temporal`, `cli` and `gateway`. Anything reached only from `service` is optional. Anything reached only through `devDependencies` is dev/test.
- **Python.** The sources are `platform/python/pyproject.toml` and the `importlib.metadata` of every distribution in `platform/python/.venv`, using `License-Expression`, then `License`, then the licence classifiers. Closures come from `Requires-Dist`, with extras evaluated.
- Script: the scratchpad `lic.cjs`, about 40 lines. It is not committed. Re-run it the same way before release.

## Summary

| Area | Packages | Licences |
|---|---|---|
| npm, Temporal-facing (kernel, temporal, cli, gateway) | 168 entries (164 distinct name@version) | MIT 84, Apache-2.0 41, BSD-3-Clause 19, "Apache-2.0 AND MIT" 11, ISC 8, BSD-2-Clause 1, 0BSD 1, Unlicense 1, **CC-BY-4.0 1**, **no licence field 1** |
| npm, service only | 1 (the service itself) | Apache-2.0 |
| npm, dev/test only | 1 (`@temporalio/testing`) | MIT |
| npm, sample ports only (`examples/temporal_samples/*`, private, never published) | `axios@^1.7.9`, `express@^4.21.2` and their trees (P11); the sample sources themselves are MIT, Temporal Technologies Inc., with `NOTICE.md` in each port and the pinned copies under `examples/upstream/` | MIT (axios, express); the trees are permissive |
| Python core (`temporalio>=1.33`) | 5 | MIT, BSD-3-Clause, Apache-2.0, PSF-2.0 |
| Python `signing` extra | 3 | Apache-2.0 OR BSD-3-Clause, MIT-0, BSD-3-Clause |
| Python `openai-agents` extra (sample) | 43 | permissive, plus **MPL-2.0** (certifi; tqdm is MPL-2.0 AND MIT) |
| Python vendored | `quickjs.wasm` (QuickJS-NG via quickjs-wasi 3.6.2), `wasmtime` wheel | MIT; Apache-2.0 WITH LLVM-exception |

**Verdict on NFR-10: it holds, with four flags to clear before a release.** No GPL, LGPL, AGPL, SSPL, BUSL or other copyleft or source-available licence is in the Temporal-facing npm path. Every licence there is Apache-compatible: Apache-2.0 can distribute MIT, BSD, ISC, 0BSD and Unlicense code. The flags follow.

## Flags

| # | Severity | Item | Why it matters | Action |
|---|---|---|---|---|
| L1 | fixed (P9 response: `LICENSE` and `files` in every package). Superseded by the P11 relicensing: `packages/temporal`, `-cli`, `-gateway`, `-service` and `python/` are now **BUSL 1.1** (production use inside one's own organisation granted; Change License Apache-2.0, four years), `packages/kernel` and the new `packages/verify` stay **Apache-2.0**; see `platform/LICENSING.md`. | Our own workspace packages (`polyflow-kernel`, `-temporal`, `-cli`, `-gateway`, `-service`) declare `"license": "Apache-2.0"`, but none has a `LICENSE` file in its package directory, and none sets `files`. | `npm publish` packs only the package directory. The repository-root `LICENSE` does not go into these tarballs. Apache-2.0 §4(a) requires that a copy of the licence ship with the work. | Add `LICENSE` (and a `NOTICE` if one is wanted) to each `packages/*`, or copy them in at `prepack`. |
| L2 | **must fix before publish** | `@cognitive-fab/polyflow-gateway` depends on `"@cognitive-fab/polyflow": "file:../../.."`. | This is a supply-chain and packaging problem, not a licence problem. A published gateway with a `file:` dependency either fails to install or resolves to whatever sits at that path on the installing machine. The target is Apache-2.0, so licensing is fine. | Depend on the registry version (`^0.4.2`), as `polygraph` already does (commit acef414). |
| L3 | note | `unionfs@4.6.0` (through `@temporalio/worker`) has **no `license` field**. Its `LICENSE` file is the Unlicense (public-domain dedication). | Automated scanners report it as "unknown". The Unlicense is Apache-compatible. | Record it in an allow-list with the file's text as evidence. |
| L4 | note | `caniuse-lite@1.0.30001810` is **CC-BY-4.0**. It arrives through `webpack → browserslist`, a dependency of `@temporalio/worker`'s bundler. | CC-BY-4.0 is a data licence and requires attribution. The package is a build-time dataset: nothing from it goes into the workflow bundle, and we do not redistribute it (npm installs it from the registry). It is still in the Temporal-facing *install* path, and a strict reading of "Apache-compatible component" flags it. | Accept as a data dependency of Temporal's own SDK. Record the attribution in NOTICE if we ever vendor it. |
| L5 | note | `@cognitive-fab/sam-pattern@2.2.1` is ISC but ships **no LICENSE file**. | ISC also requires the notice to be kept with copies. This is our own org's package. | Add `LICENSE` to sam-pattern and republish. |
| L6 | note | `@temporalio/core-bridge@1.24.0` (MIT) ships a prebuilt native binary compiled from 378 Rust crates (its `Cargo.lock`). Among them is `option-ext 0.2.0` (via `dirs-sys`), which is MPL-2.0, based on known crate licensing; there is no crates.io metadata offline to check it. The rest are permissive: MIT/Apache, `ring` (Apache-2.0 AND ISC), `webpki-root-certs` (CDLA-Permissive-2.0), and `unicode-ident` (adds Unicode-3.0). | This is Temporal's own shipped artefact, and MPL-2.0 is file-level copyleft, compatible with a larger Apache work. We redistribute nothing of it. | None for us. If an acquirer's legal team asks, point at Temporal's own NOTICE. |
| L7 | note | Python: the `openai-agents` extra pulls `certifi` (MPL-2.0) and `tqdm` (MPL-2.0 AND MIT). `quickjs` 1.19.4 (PyPI, installed in the venv) has **no licence metadata**. Its LICENSE file is MIT (the file's header credits AngularJS/Google). | These are not in the Temporal-facing Python core. The extra is for the S2 sample only. `quickjs` is not imported by the package: the new `quickjs_engines.py` uses the vendored WASM under `wasmtime`. | Keep MPL deps out of the core extra. Remove `quickjs` from the venv if it is unused. Add `License-Expression` metadata to our own `pyproject.toml` (see L8). |
| L7b | note | Python: the `langgraph` extra (P10) also pulls MPL-2.0 code: `certifi` (MPL-2.0; through `langchain-core → httpx` and `langsmith → requests`) and `orjson` 3.12.0 (`MPL-2.0 AND (Apache-2.0 OR MIT)`; through `langsmith`) (P10 review LC1). A LangGraph-only install also installs `temporalio`, though the binding never imports it. | MPL-2.0 is file-level copyleft on those packages' own files only; nothing here modifies them. Still, the statement "MPL confined to openai-agents" no longer holds. | Name both extras in the audit (done here). Split the kernel into its own package, so the LangGraph extra carries no Temporal dependency (follow-up). |
| L8 | note | `platform/python/pyproject.toml` declares `license = { text = "Apache-2.0" }` (legacy form) and has no licence file entry. | PEP 639 wants `license = "Apache-2.0"` plus `license-files`. Without it, the wheel carries no licence text (same issue as L1). | Change to `license = "Apache-2.0"`, `license-files = ["LICENSE"]`, and add the file. |
| L9 | note | Vendored `polyflow_temporal/vendor/quickjs-wasi/quickjs.wasm` has a `PROVENANCE.txt` with tarball and file SHA-256s and an MIT `LICENSE` (quickjs-wasi, and QuickJS-NG). | This is well done. The binary is part of the governed path (the Python G2 host), so it is a supply-chain item. | Add a test that recomputes the pinned SHA-256 of `quickjs.wasm`, so a swapped binary fails CI. |

## Temporal-facing npm path, by licence

(The Temporal SDK is MIT. Its bundler toolchain, webpack and swc, is a runtime dependency of `@temporalio/worker`, so it counts as Temporal-facing.)

- **Apache-2.0 (41):** our five packages and `@cognitive-fab/polyflow` 0.4.2, `@cognitive-fab/polygraph` 8.3.0, `@grpc/grpc-js`, `@grpc/proto-loader`, the `@jsonjoy.com/*` family (memfs), `memfs`, `tree-dump`, `glob-to-regex.js`, `@swc/core`, `@swc/counter`, `@swc/types`, `@swc/core-linux-arm-gnueabihf`, `@webassemblyjs/leb128`, `@xtuc/long`, `long`, `rxjs`, `baseline-browser-mapping`.
- **Apache-2.0 AND MIT (11):** the `@swc/core-<platform>` native binaries (optional, per OS).
- **MIT (84):** the `@temporalio/*` SDK (activity, client, common, core-bridge, nexus, proto, worker, workflow), `webpack` and its loaders, `@webassemblyjs/*`, `ajv*`, `acorn`, `uuid`, `nexus-rpc`, `yargs`, and more.
- **BSD-3-Clause (19):** `protobufjs` (7.6.6 and 8.8.0) and `@protobufjs/*`, `source-map`, `source-map-js`, `heap-js`, `fast-uri`, `@xtuc/ieee754`.
- **ISC (8):** `@cognitive-fab/sam-pattern`, `cliui`, `electron-to-chromium`, `get-caller-file`, `graceful-fs`, `picocolors`, `y18n`, `yargs-parser`.
- **BSD-2-Clause:** `terser`. **0BSD:** `tslib`. **Unlicense:** `fs-monkey`. **CC-BY-4.0:** `caniuse-lite` (L4). **No field:** `unionfs` (L3).

## Our own packages' licence fields

| Package | `license` | LICENSE file in package |
|---|---|---|
| `@cognitive-fab/polyflow-platform` (workspace root, private) | Apache-2.0 | n/a (private) |
| `@cognitive-fab/polyflow-kernel` 0.1.0 | Apache-2.0 | **no** |
| `@cognitive-fab/polyflow-temporal` 0.1.0 | Apache-2.0 | **no** |
| `@cognitive-fab/polyflow-cli` 0.1.0 | Apache-2.0 | **no** |
| `@cognitive-fab/polyflow-gateway` 0.1.0 | Apache-2.0 | **no** |
| `@cognitive-fab/polyflow-service` 0.1.0 | Apache-2.0 | **no** |
| `@cognitive-fab/polyflow` 0.4.2 (repo root) | Apache-2.0 | yes |
| `polyflow-temporal` (Python) 0.1.0 | `{ text = "Apache-2.0" }` | **no** |

The verifier (`polyflow verify` in the CLI, and `verifyBundle` in the temporal package) is Apache-2.0, as NFR-10 requires. Its runtime needs only `node:crypto` and the kernel, which has zero dependencies.

## Supply-chain observations (not licence)

- Every npm entry in the lock has a `resolved` registry URL and a `sha512` integrity. The lock pins exact versions. `ms@3.0.0-canary.1` (a **canary** release, via the Temporal SDK) is the one pre-release in the tree.
- The worker bundles workflow code with webpack at `Worker.create`. The bundler and its plugins (swc native binaries, terser) run in the worker process with the worker's privileges. They are Temporal's supply chain, and ours by inheritance. Pin them via the lock, and prefer pre-built bundles (`bundlerOptions` plus a build-time `bundleWorkflowCode`) in production. See also finding SEC-KY1 in the security review: a pre-built bundle contains the header data key.
- The kernel (the code that runs in the isolate and verifies) has **zero** dependencies, including its crypto (pure-JS SHA-256, SHA-512, ed25519 verify and ChaCha20-Poly1305). That keeps the verifier's dependency surface empty. The cost is that the crypto is ours to maintain (see the review's crypto section).
- The Python core depends only on `temporalio` and its 4 dependencies. `cryptography` is opt-in (`[signing]`).
