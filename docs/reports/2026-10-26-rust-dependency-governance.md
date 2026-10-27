# Rust dependency governance — 2026-10-26

## Scope and acceptance

Audit the current Rust workspace's dependency declarations, duplicate versions
and enabled features; remove demonstrably unused edges without removing product
capabilities; measure the resolved graph before and after; validate consumers and
keep the feature reductions enforced by the existing architecture gate.

The baseline is the shared working tree at the start of this task, including
its pre-existing Cargo.lock and manifest changes. No source changes from other
sessions were reverted. Raw baseline snapshots, metadata, dependency trees and
verification logs are in `.cache/rust-dependency-governance/2026-10-26/`.

The inventory used Cargo metadata plus source-reference inspection and manual
review of feature-only, generated-code and build-permission dependencies.
`cargo-machete` was unavailable locally and its registry installation could not
complete; no machete result is claimed. The two standalone component manifests
and three first-party lockfiles were also inventoried, while the vendored
LiteParse patch is retained as a separate upstream source snapshot.

## Implemented changes

- Remove 25 unused dependency declarations across nine consumers. The desktop
  shell accounts for 17, including its unused host-service dev dependency. These
  edges survived earlier subsystem extractions; their owning crates retain the
  dependencies needed at runtime.
- Build `wasmtime-wasi` 49.0.4 with `default-features = false` and `p2` only.
  `wasm/wit/since_v0_2.rs::build_linker` registers Preview 2, and the host's WIT
  contract is a component world. Preview 1's wiggle adapter and Preview 3's
  component async/bytes support are unused. Wasmtime's `async`, component model,
  runtime and Cranelift remain enabled.
- Replace the local browser's Tokio `full` feature with `fs`, `io-util`,
  `macros`, `net`, `process`, `rt-multi-thread`, `sync` and `time`. These cover
  the supervisor, installer, local HTTP server and discovery paths.
- Extend `check-rust-architecture.mjs` and its existing config and tests to
  reject direct Tokio `full`, WASI defaults, and WASI features beyond `p2`.
  The check includes dev/build/target declarations, renamed dependencies and
  strong/weak feature forwarding. It runs through the existing
  `pnpm audit:rust-architecture` / `check:all` Rust gate; no extra CI job is needed.
- Inherit the workspace license in `cognia-github-runner`. The original
  metadata reproduces cargo-deny's `unlicensed` failure; the package now
  declares the same AGPL license as the rest of this repository.

Removed declarations:

| Consumer            | Dependencies removed                                                                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cognia-next`       | `aes-gcm`, `axum-server`, `cognia-companion-contract`, `cognia-git-mirror`, `cognia-headless-contract`, `cognia-host-service` (normal and dev), `hyper`, `hyper-util`, `jsonwebtoken`, `local-ip-address`, `regex`, `rusqlite`, `serde_urlencoded`, `sha1`, `tokio-tungstenite`, `wait-timeout` |
| `cognia-automation` | `objc2-foundation`                                                                                                                                                                                                                                                                              |
| `cognia-ocr`        | `objc2-core-foundation`                                                                                                                                                                                                                                                                         |
| `cognia-codeserver` | `tower` (dev)                                                                                                                                                                                                                                                                                   |
| `cognia-hooks`      | `tempfile` (dev)                                                                                                                                                                                                                                                                                |
| `cognia-mcp-server` | `tower` (dev)                                                                                                                                                                                                                                                                                   |
| `cognia-file-share` | `thiserror`                                                                                                                                                                                                                                                                                     |
| `cognia-tts`        | `parking_lot`                                                                                                                                                                                                                                                                                   |
| `cognia-vector`     | `urlencoding` (dev)                                                                                                                                                                                                                                                                             |

## Measured graph changes

Measured using locked, offline Cargo resolution on aarch64-apple-darwin. The
workspace contains 70 members. Package counts include unique name/version
identities, rather than counting repeated tree lines as separate packages.

| Measurement                                                 |  Before | After |
| ----------------------------------------------------------- | ------: | ----: |
| Default workspace resolved packages (`cargo metadata`)      |   1,507 | 1,500 |
| Plugin runtime normal/build dependencies, including root    |     432 |   426 |
| Desktop normal/build dependencies, including root           |   1,097 | 1,091 |
| WASI previews enabled                                       | 1, 2, 3 |     2 |
| Local browser enables Tokio `full`                          |     yes |    no |
| Multi-version package names in default workspace resolution |     150 |   150 |

Seven packages disappear from resolution and the lockfile: `wiggle`,
`wiggle-generate`, `wiggle-macro`, `witx`, `wast 35`, `leb128`, and the unused
dev-only `urlencoding`. No package version is added, upgraded or downgraded.
Removing an unused direct edge does not remove the package when another live
consumer still needs it. The production graphs lose six packages; the seventh
was test-only.

These are dependency-graph measurements. No binary-size, cold-build-time or
runtime-speed improvement is claimed without a controlled benchmark.

## Dependencies retained after review

- `rustls` declarations in `cognia-e2b`, `cognia-environment` and
  `cognia-sandbox-pool` enable the crypto provider for `rustls-no-provider`
  clients even where no Rust identifier references the crate.
- The desktop's `tauri-plugin-log` declaration supplies permissions consumed by
  `tauri-build`; transitive Rust usage alone would not preserve those permissions.
- `test-inmemory` / `test-support` dev dependencies that make existing tests
  hermetic remain. The server's `cognia-ocr` dependency forwards its OCR feature
  contract and is also retained.
- Default OCR, Matrix encryption, WebRTC, WASM execution and sandbox providers
  remain available. Turning these off would change shipped capabilities.
- Standalone WASM template/example manifests remain separate from the desktop
  workspace, as required by their component target and release profiles.

## Duplicate-version findings

The remaining 150 multi-version names are mostly transitive constraints. Specific
owners were checked in the resolved metadata:

| Duplicate                       | Owning constraints                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `reqwest` 0.12 / 0.13           | `tauri-plugin-upload` 2.5.0 uses 0.12; workspace consumers and updater use 0.13                   |
| `tokio-tungstenite` 0.29 / 0.30 | Axum 0.8.9 and kube-client 4.2.0 use 0.29; Cognia uses 0.30                                       |
| `tower-http` 0.6 / 0.7          | Reqwest and kube-client retain 0.6; workspace servers use 0.7                                     |
| `wasmparser` 0.258 / 0.259      | Wasmtime 49.0.4 and its matching WIT toolchain use 0.258; plugin runtime/CLI validation use 0.259 |
| `windows` 0.58 / 0.61 / 0.62    | eventlog uses 0.58, enigo uses 0.61; Tauri/UIA/Cognia use 0.62                                    |

Do not force cross-major replacements through Cargo patches. Revisit these when
their owning parents support one compatible version; keep the exact Wasmtime
security pin until an independently validated upgrade is available.

## Verification

- Gate regression tests: two new behavioral tests failed before the
  implementation, then all **26 passed**. The real gate initially rejected
  exactly the broad WASI defaults and Tokio `full`, then passed after pruning.
- `pnpm audit:rust-architecture`: passed for 70 members; its two existing
  baselined architectural findings are unchanged.
- `pnpm lint`: passed. Changed gate files also passed targeted ESLint and
  Prettier checks.
- `pnpm lint:i18n` and `pnpm i18n:sort:check`: passed.
- `cargo deny --locked --offline check --hide-inclusion-graph`: passed all four
  checks after the license metadata fix. Existing advisory exceptions and
  duplicate warnings remain visible. This uses the cached RustSec database at
  `4b587f00996ebe5c05a73eaef105ef241e876414` (2026-10-21), so it is not a claim
  of a fresh 2026-10-26 vulnerability scan.
- `cargo check --locked --offline --all-targets` for `cognia-next`,
  `cognia-plugin-runtime`, `cognia-local-browser`, `cognia-hooks`,
  `cognia-codeserver`, `cognia-mcp-server`, `cognia-file-share`, `cognia-tts`,
  `cognia-vector`, `cognia-automation` and `cognia-ocr`: **passed**, 5m34s,
  including desktop default OCR and all selected test targets. One existing
  `HeadlessSidecarHost` unused-import warning in the desktop's test build remains.
- `cargo test --locked --offline -p cognia-local-browser --lib -j 2`:
  **103 passed**, including real loopback HTTP serving and supervisor process
  start/stop/recovery tests.
- `cargo test --locked --offline -p cognia-plugin-runtime --lib wasm:: -j 2`:
  **156 passed**, 462 unrelated tests filtered out. Includes store/linker,
  component-validation, installer, capability and renderer-bridge tests.
  The two crates were tested separately so workspace feature unification cannot
  mask missing features. Combined with the gate's 26 tests, **285 tests passed**.
- Read-only Rust/Tauri, test-gap and gate-wiring reviews found no actionable
  regression. Concurrent manifest and lock entries were rechecked against the
  initial snapshots; their unrelated changes remain present.

Repository-wide checks also exposed unrelated shared-tree failures:

- `pnpm typecheck`: fails in context-workbench test fixtures (missing `activity`),
  `use-claude-chat.test.ts` mock typing, and Discord avatar BigInt literals under
  an older TypeScript target. None of these files is changed by this task.
- `cargo fmt --all -- --check`: reports formatting in existing automation and
  other concurrently edited Rust source. No Rust source is edited by this task;
  broad formatting would overwrite another task's scope.
- Strict focused `cargo clippy --locked --offline -p cognia-local-browser
-p cognia-plugin-runtime --all-targets -j 2 -- -D warnings`: fails on existing
  plugin-runtime `run_process` argument count (`node_runtime.rs:826`) and a test
  fixture's complex type (`cogpack_transfer.rs:728`). These source constructs
  also exist at HEAD; this task does not change either file. No lint allowances
  or baseline changes were added.

No coverage command was run, and no frontend UI or public command behavior was
changed. Windows/Linux execution, full application packaging, release size and
installed-plugin end-to-end acceptance are not claimed by this report.

## Further opportunities — graph-only follow-up

A subsequent read-only audit compared independent manifest variants under
`.cache/rust-dependency-governance/2026-10-26/followup-probe/`. Production
manifests, sources and lockfiles were not changed in this follow-up. All counts
below use the current macOS default desktop normal/build graph, including the
root package, with the same resolved versions. These are graph experiments,
not compiled or behavior-tested implementations and not binary-size estimates.

| Candidate                                                        | Measured package reduction | Evidence and implementation boundary                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | -------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove `kube/runtime` from `cognia-sandbox-pool`                 |          7 (1,091 → 1,084) | Its Kubernetes provider uses the client/config/API surface, not runtime helpers. Remove only its `runtime` request. `cognia-external-agent/src/kube_backend.rs:327` really uses `runtime::wait`, so its `k8s-exec` flavor must retain runtime.                                                                                                                                                                              |
| Use `reqwest/rustls-no-provider` in `cognia-automation`          |          4 (1,091 → 1,087) | This crate currently enables `rustls`, selecting AWS-LC in addition to the existing ring provider. Its managed HTTP clients route through `cognia-net::proxy_config::managed_client`, which installs ring. The desktop experiment removes `aws-lc-rs`, `aws-lc-sys`, `cmake` and `fs_extra`. Verify HTTPS, proxy and standalone crate initialization before shipping.                                                       |
| Select ZIP's `deflate-flate2-zlib-rs` instead of broad `deflate` |          1 (1,091 → 1,090) | ZIP 9.0.5's `deflate` also enables Zopfli, but current producers do not select compression levels above 9. Existing deflate read/write support can use flate2. Test archive round-trips, Unicode names and updater extraction; native Windows installer acceptance is a separate check.                                                                                                                                     |
| Disable only the unused AVIF encoder in the OCR image stack      |         26 (1,091 → 1,065) | `oar-ocr` and `oar-ocr-core` directly enable `image/default` and inherit `imageproc/default`, which forwards `image/default` again. The experiment patches both upstream manifests and preserves all other default formats plus imageproc's rayon/text/FFT features. It removes `ravif`, `rav1e` and their AV1 support chain. Requires upstream feature support or a maintained patch, and real OCR/screenshot regressions. |

The first three changes combined reduce the default desktop graph from **1,091
to 1,079**, with no additional package versions. Package count understates the
potential cost of the AWS-LC native build and AV1 encoder graph; actual time and
size savings still need measurement.

The image experiment disables the `avif` encoder feature. `avif-native`, which
enables the AVIF decoder in this locked image version, is already absent.
A more aggressive PNG/JPEG/WebP/BMP/TIFF-only image variant removes 36 packages,
but would additionally drop other currently enabled formats. That variant
requires a product compatibility decision and is not the recommended first cut.

Other smaller candidates:

- Direct `wasmparser` 0.259 users only read payloads/custom sections; inspect
  whether its validator/serde/default features can be disabled. Keep Wasmtime's
  own validator intact, and do not downgrade the parser solely to merge versions.
- A maintained `tauri-plugin-upload` parent compatible with reqwest 0.13 could
  eventually remove the second reqwest line. No suitable parent upgrade was
  established by this follow-up; replacing the plugin also requires retaining
  progress, cancellation and upload/download behavior.
- Keep ZIP BZip2 extraction until compatibility expectations are established:
  code generating only deflate archives does not prove externally supplied
  BZip2 archives are unsupported.
- Default PaddleOCR, Matrix encryption and WebRTC still provide product
  capabilities. A separate lightweight build flavor can save more, but disabling
  them in the current default would change behavior.

Raw independent and combined trees, removed package lists and experiment
summaries are in `followup-probe-summary.json` and `*-probe-tree.txt` beside the
original evidence. No additional tests were executed in this graph-only audit.

## Phase 2 implementation — preserve existing capabilities

Implemented on 2026-10-26; final verification continued on 2026-10-27
(Asia/Shanghai).

The user authorized implementation with an explicit requirement to preserve
existing functionality. This phase implements the first three graph probes:

- `cognia-automation` now requests `reqwest/rustls-no-provider`. Its two HTTP
  clients use `cognia-net::proxy_config::managed_client`, which installs ring
  before building the client. The desktop and server entry points already
  install ring explicitly, so the selected runtime provider remains ring.
- Only `cognia-sandbox-pool` drops `kube/runtime`. Its client/config, Kubernetes
  resources, exec streams, readiness and deletion paths remain compiled.
  `cognia-external-agent/k8s-exec` retains `runtime::wait` and was tested separately.
- Seven ZIP consumers explicitly request `deflate-flate2-zlib-rs`. Stored and
  Deflate read/write remain; BZip2 remains enabled in every consumer that
  previously supported it. No current producer selects a compression level
  above 9. Unicode names, archive authentication and extraction confinement
  are unchanged.
- Architecture policy now rejects these broad feature requests. The kube rule
  is consumer-scoped, so it cannot inadvertently remove the other backend's
  readiness helper. A regression test first failed because the gate applied
  a scoped rule to both consumers, then passed after scope handling was added.
- A new co-located installer regression installs archives with Stored,
  Deflate levels 1/6/9, and BZip2 through the actual bundle installation entry
  point, asserting Unicode asset names and exact binary bytes. The corrected
  test passed before changing the ZIP features, establishing the compatibility
  baseline, and is rerun against the new backend.

The OCR/image stack is deliberately unchanged in this implementation. Removing
its AVIF encoder requires patching two upstream manifests; the larger format
pruning variant would change currently enabled formats. Neither is necessary
for this safe first implementation. No OCR, Matrix, WebRTC or sandbox provider
was disabled.

Actual default macOS desktop normal/build dependencies are **1,091 → 1,079**
with no new versions. The full workspace lockfile only loses Zopfli
(**1,561 → 1,560** packages), because other workspace/flavor consumers still
need the remaining packages. The locked updater's Windows ZIP dependency has
`default-features = false` and requests no compressor itself; its extraction
backend remains supplied by the app's direct ZIP features. A Windows-target
dependency tree resolved successfully, but Windows installer execution has
not been performed.

Verification for this phase:

- Architecture gate: **27 passed** and the real 70-member gate passed.
- Network library: **220 passed**, including real HTTPS, HTTPS proxy TLS before
  CONNECT, SOCKS, proxy authentication, bypass and fail-closed behavior.
- Sandbox pool, independently with `--features kubernetes,e2b`: **361 passed,
  2 ignored**, including fake Kubernetes API/exec/readiness/recovery scenarios.
- External-agent, independently with `--features k8s-exec`: **343 passed**.
- ZIP consumer suites: codeserver **171 passed**, GitHub runner **18 passed**,
  local browser **103 passed**, observability **188 passed**. The CLI's
  `engine::packaging::tests` also passed all **9** cases.
- Full plugin-runtime suite: **616 passed, 2 failed, 1 ignored**. Both failures
  are existing protocol-version expectations (`1.2.0`) against the canonical
  catalog/host value (`1.3.0`):
  `contract::tests::exposes_protocol_versions_from_the_canonical_catalog` and
  `python::commands::tests::runtime_info_serializes_snake_case`. Each failure
  was reproduced by running the test binary built before the phase-2 manifest
  changes (`cognia_plugin_runtime-239972d238731936`), with no rebuild or checkout.
  The new compression compatibility test passes on both backends. No existing
  assertion was weakened and no protocol source was modified.
- Including the gate, these non-repeated suites record **2,056 passing tests,
  2 baseline failures and 3 ignored tests**. The two protocol failures mean the
  full plugin suite is not green; this is not represented as a passing suite.
- `cargo check --locked --offline --all-targets` passed for all ten selected
  consumers (`cognia-next`, CLI, automation, sandbox-pool, external-agent,
  codeserver, plugin-runtime, GitHub runner, local-browser and observability),
  with the desktop's default OCR, WebRTC harness and external-agent's
  `k8s-exec` enabled. Completed in **1m54s**; the same existing desktop test
  unused-import warning remains. This includes the real updater crate.
- Independent `cargo check --locked --offline -p cognia-automation --all-targets
-j 2` also passed (**39.51s**), without the desktop's feature unification.
- Repository ESLint and i18n lint passed; changed Rust test source passed
  rustfmt; offline cargo-deny passed advisories, bans, licenses and sources
  against the same cached advisory database documented above.
- Rust/Tauri, test-gap and gate-wiring reviewers found no actionable regression.

Raw evidence and the separate phase baseline are in
`.cache/rust-dependency-governance/2026-10-26/phase2/`. Full packaging,
Windows/Linux execution, physical-device acceptance and binary-size gains remain
outside these results. The earlier unrelated TypeScript, global rustfmt and
strict clippy findings were not changed or suppressed by this phase.

## Remaining candidates — 2026-10-27 read-only review

An unshipped candidate is narrowing direct `wasmparser` 0.259 features
in the CLI and plugin runtime. All owning call sites use `Parser`, `Chunk` and
`Payload` to inspect sections; none uses `Validator` or serializes wasmparser
collections. A shadow-manifest variant preserves `std`, `component-model`,
runtime feature configuration and SIMD parsing while disabling validator,
serde and hash-collection support. It keeps the version unchanged and leaves
Wasmtime's separate 0.258 validator intact. Both dependency graphs retain the
same package count (CLI **220 → 220**, desktop **1,079 → 1,079**), since other
consumers still need the shared packages. Any improvement must be measured in
compile work or artifact size, not advertised as removed packages. This variant
has not been compiled or behavior-tested.

The standalone WASM template directly declares `serde/derive`, but its source
only uses `serde_json::Value` and JSON helpers. This is another small candidate
for real component-build validation. Both the template and formatter example
also declare `wit-bindgen-rt` **0.44** while their local ignored lockfiles still hold
**0.34.0**. That local drift affects `--locked` builds in this checkout; neither lockfile is tracked by Git, and
the CLI's embedded template list does not include Cargo.lock, so it is not
evidence that every newly scaffolded plugin inherits the stale lock. The offline
probe could not finish because wit-bindgen-rt 0.44 was absent from the local
cache; no package-reduction or compilation result is claimed for this candidate.

The largest previously measured opportunity remains the unused AVIF encoder
chain (**26 desktop graph packages**). It still requires upstream OAR feature
support or a maintained patch, with all other image formats and rayon/text/FFT
preserved and actual OCR/screenshot acceptance before shipping.

Two apparent easy cuts were rejected after inspecting their owning source:

- `fontconfig-parser` already has a Unix/non-macOS/non-Android target predicate
  in fontdb 0.24, so it is not part of the macOS build. Removing its feature
  globally could change Linux font discovery without improving macOS.
- The CLI's native TLS is used by HTTPS host connections, explicit pinned
  certificates and ACP WSS. The loopback bridge's plain HTTP comment is not
  evidence that the whole CLI can drop TLS. Backend consolidation would need
  separate trust/pinning and platform compatibility tests.

`tauri-plugin-upload` 2.5.0 still owns the extra reqwest 0.12 line; the official
v2 manifest retrieved during this review also declares 0.12. Parent migration
or replacement must retain progress, cancellation and transfer behavior. No
forced dependency-version override is proposed.

This review changed no production manifests or lockfiles. New raw probe trees
and summaries are under `.cache/rust-dependency-governance/2026-10-27/`.

## WASM implementation audit — 2026-10-27

The follow-up challenged whether unused features actually indicated missing
plugin support. Native WASM support is wired through the desktop commands and
headless RPC into the same component host. However, the earlier archive tests
and dependency checks did not prove a real guest could activate. A real CLI
scaffold exposed three existing implementation defects, now repaired:

| Boundary            | Reproduced failure                                                              | Repair                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component loading   | `scan api-version: expected section, got wasm magic number (at offset 0x18c3e)` | Skip embedded module/component bytes with the parent parser; only trust the outer component's API version. Apply the same correction to CLI inspection. |
| Activation          | `instantiate component: resource limit exceeded: instance count too high at 2`  | Allow up to 64 core instances within one plugin component for the guest, adapter and ABI shims. Keep the single-memory, memory-byte and table limits.   |
| Workflow invocation | Unicode tool/event echo succeeds, but workflow returns an empty message         | Read the host's `{ kind, params, upstream }` envelope in the starter's workflow export.                                                                 |

Build setup also checked `wasm32-wasip2` while cargo-component 0.21.1 actually
compiled `wasm32-wasip1` and adapted it into a Preview 2 component. CLI build
now selects that target explicitly; preflight, doctor, scaffolding hints and
author instructions agree. Packaging prefers the fresh target over stale
wasip2 output, with a regression covering both directories. The template owns
an empty workspace so scaffolding inside another Cargo workspace also works.
The embedded README substitutes the author's plugin name in artifact paths
and tells authors to install the CLI ZIP with its required API-version section.

This build target is distinct from the host's WASI support. A component adapted
from wasip1 still imports Preview 2 interfaces. It does not require registering
the host's unused Preview 1 linker. No additional dependency pruning was made
during this audit; the proposed wasmparser feature reduction remains unshipped.

Verification completed:

- **781 tests passed:** CLI 475 unit + 15 surface + 127 integration; native WASM
  runtime 160; starter 4 (same source copied into a cache-only standalone test
  crate with generated bindings). The earlier two unrelated protocol-version
  failures in the full plugin-runtime suite are outside this focused run.
- Regression tests failed first for p1 toolchain readiness and the workflow
  parameter envelope. The actual original compiled guest failed loading;
  after the parser fix it exposed the core-instance limit, then the workflow
  input failure. These failures were retained as evidence.
- Fresh `cognia plugin new` → `cognia plugin build` succeeded with cargo-component
  0.21.1, Rust 1.99 and the wasip1 target. `cognia plugin info --json` reads the
  resulting component's API version as `0.2.0`.
- The real ZIP was unpacked into a cache-only install root. A standalone harness
  called the production `*_for_state` functions: load → activate → tool/event/
  workflow calls carrying `真实 WASM ✓` → deactivate → unload all passed.
  This verifies actual guest execution, rather than a mock or empty component.
  The native installer UI, renderer round trips and capability backends were
  not exercised by this harness.
- Tauri-enabled plugin-runtime `cargo check --locked --offline --all-targets
--features tauri-host` passed. ESLint, frozen v0.1 API and all four WIT-mirror
  gates passed. Rust/Tauri, test-gap and wiring reviewers cleared the final
  scoped changes after their artifact-selection and README findings were fixed.

The final ZIP is 48,552 bytes, SHA-256
`75a8578155256fdd3334ed0f9523ac863a6cb87552c0d9a922a5005decdf2903`.
Raw logs, original-source snapshots, scaffolds and the host harness are in
`.cache/wasm-support-audit/2026-10-27/`, including `real-host-before.log`,
`real-host-parser-fixed.log`, `real-host-old-guest.log`, `real-host-final.log`,
`cli-tests-final.log`, `wasm-tests-final.log` and `guest-tests.log`.

One genuine capability gap remains: the formatter example cannot feed a WASI
guest file to host `rustfmt`. The current process WIT interface has no stdin
channel, and guest paths are not host paths. Extending that interface requires
a separately versioned contract change and host/guest compatibility work;
restoring unused WASI feature defaults would not implement it. Browser/mobile
clients also deliberately require a native host for WASM execution.

## Sources

- [Cargo feature resolution](https://doc.rust-lang.org/cargo/reference/features.html)
- [Cargo resolver and feature unification](https://doc.rust-lang.org/cargo/reference/resolver.html)
- [cargo tree duplicate analysis](https://doc.rust-lang.org/cargo/commands/cargo-tree.html)
- [Reqwest 0.13.5 optional features](https://docs.rs/reqwest/0.13.5/reqwest/#optional-features)
- [ZIP feature definitions](https://docs.rs/zip/latest/zip/#features); the exact
  9.0.5 manifest in the local registry was used for the probe.
- [Kube client/runtime feature separation](https://docs.rs/kube/4.2.0/kube/)
- [Image 0.25.10 API](https://docs.rs/image/0.25.10/image/); local image,
  oar-ocr, oar-ocr-core and imageproc manifests establish the default-feature
  activation paths described above.
- [Wasmparser feature definitions](https://raw.githubusercontent.com/bytecodealliance/wasm-tools/main/crates/wasmparser/Cargo.toml), cross-checked against the locked 0.259.0 local manifest.
- [Ureq 3.4.2 TLS features and explicit backend selection](https://docs.rs/ureq/3.4.2/ureq/#features).
- [Official upload plugin manifest](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/upload/Cargo.toml).
- Local locked `wasmtime-wasi-49.0.4/Cargo.toml` feature definitions and Cognia's
  `crates/cognia-plugin-runtime/src/wasm/wit/since_v0_2.rs` linker are the owning
  evidence for the WASI reduction.
- [cargo-component 0.21.1 WASI target and adaptation](https://github.com/bytecodealliance/cargo-component/blob/v0.21.1/README.md#wasi-support).
- [Rust wasm32-wasip2 component target](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip2.html).
