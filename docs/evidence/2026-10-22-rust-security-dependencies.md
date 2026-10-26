# Evidence ledger: Rust security dependencies

- Status: verifying
- Lane: standard
- Created: 2026-10-22
- Updated: 2026-10-22
- Related: RustSec advisory database commit 4b587f00996ebe5c05a73eaef105ef241e876414

## Original request

> 帮我更新一下依赖，看下今天rust的漏洞，看看我的项目里有没有漏洞版本的

## Knowledge

| ID  | Statement                                                                                                                               | State    | Basis                                                                                | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ | ---------- |
| O1  | Main lockfile contains 37 vulnerability matches; diagnostic service contains 8.                                                         | Verified | cargo audit JSON before update, macOS, 2026-10-22; .cache/security/2026-10-22/       | -          |
| O2  | emSign trust issue affects rustls-webpki 0.103.15 and webpki roots/certs 1.0.9 in both lockfiles.                                       | Verified | RUSTSEC-2026-0381/0382/0383; issued 2026-10-20; checked 2026-10-22                   | O1         |
| O3  | Wasmtime 49.0.1 is exactly pinned; zip 8 is direct, zip 4 comes from the Windows updater; lopdf 0.38 comes from optional liteparse.     | Verified | Cargo manifests, lockfile reverse edges, ADR-0067/0196; 2026-10-22                   | O1         |
| C1  | Preserve concurrent changes and existing advisory exceptions; do not claim deployed fixes.                                              | Verified | User instructions and concurrent-tree-safety skill; 2026-10-22                       | -          |
| O4  | The official updater Git revision 11211c30e71796cd737280303244552bb7f70797 uses ZIP 9; published updater 2.14.0 still uses ZIP 4.       | Verified | Exact upstream manifest, Cargo Git checkout and locked all-target tree; 2026-10-22   | O3         |
| O5  | Vendored LiteParse 2.15.1 with lopdf 0.46.0 preserves production source and passes native feature compilation and PDF regression tests. | Verified | Registry file comparison, native-check.log and liteparse-tests-rerun.log; 2026-10-22 | O3         |
| G1  | Inventory all Rust lockfiles and update affected dependencies where compatible, reporting remaining vulnerable versions.                | Agreed   | User request; 2026-10-22                                                             | -          |

## Problem frame

Resolve known vulnerable Rust dependencies in the main workspace and standalone services, prioritizing the current emSign trust issue (O2). Scan all seven lockfiles, record upstream constraints explicitly, and verify the affected consumers. No unrelated JavaScript upgrades or deployment is included.

Subsequent user requests expanded the session to Cloudflare services and Node.js/frontend dependencies. Those follow-up changes, verification, remaining advisories, and the unresolved Cloudflare login/deployment boundary are recorded separately in [the Node/frontend security report](../reports/2026-10-22-node-frontend-security-audit.md). This ledger retains the original Rust verification scope.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                                                  |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| scale        | medium | Seven Rust lockfiles; two initially contain vulnerable TLS dependencies.                                                     |
| technical    | medium | Patch updates plus a ZIP major update requiring compilation checks.                                                          |
| coupling     | medium | Workspace dependencies, Wasmtime exact version group, Windows updater transitive dependency.                                 |
| requirement  | low    | Security inventory and updates are explicit.                                                                                 |
| verification | high   | Available space fell from 6.5 GiB to 163 MiB during concurrent work, then recovered to 1.6 GiB; native compilation is large. |
| risk         | medium | TLS trust and plugin execution are security boundaries.                                                                      |

## Risks

| ID  | Risk (impact)                                                | Severity | Source                         | Claim                                                                                                            | Refuted by                                             |
| --- | ------------------------------------------------------------ | -------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| R1  | Vulnerable TLS or plugin versions remain unnoticed.          | high     | RustSec advisories             | Every lockfile is scanned and residual matches are listed.                                                       | Unreported vulnerability in post-update audit.         |
| R2  | Dependency updates break archive, HTTP or plugin consumers.  | medium   | ADR-0067/0196; Cargo manifests | Compatible APIs compile and focused behavior checks pass.                                                        | Compilation or relevant test failure caused by update. |
| R3  | Shared-tree edits are overwritten or swept into this change. | medium   | concurrent-tree-safety         | Only task dependency files, ZIP API compatibility call sites, their tests and this evidence document are edited. | Baseline comparison shows unrelated changes removed.   |

## Verification obligations

| ID  | Risk | Method                                                                                          | Independence | Evidence                                                                                                                                                                                                                                                        | Coverage                                                                                                     | Status  |
| --- | ---- | ----------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------- |
| V1  | R1   | Audit all seven lockfiles before and after with refreshed RustSec DB.                           | tool         | cargo audit --no-fetch --no-yanked --json --file <lockfile>: main 37 → 5, diagnostic 8 → 1, other five 0 → 0; audit-summary.json.                                                                                                                               | All platforms and optional locked packages; yanked status excluded due registry timeouts.                    | passed  |
| V2  | R2   | Locked metadata, relevant cargo check and existing tests for HTTP, archives and plugin runtime. | tool         | Main and diagnostic cargo metadata --locked --no-deps passed; cargo test --locked -p cognia-net --lib -j 1: 200 passed, 0 failed; six-consumer all-targets check passed; github-runner 18 passed. Full plugin/Tauri runtime tests blocked by 207 MiB free disk. | macOS host; native app execution, full plugin tests and per-consumer decode error cases remain unverified.   | blocked |
| V3  | R3   | Inspect manifest/lockfile diff and compare task baseline snapshots.                             | tool         | git diff --check passed; baseline TOML comparison contains only TLS, Wasmtime/Cranelift and ZIP version groups; updater/LiteParse unchanged.                                                                                                                    | Three manifests, two lockfiles, ten Rust compatibility/test files and this report; no unrelated work staged. | passed  |

| V4 | R1 | Re-audit all seven lockfiles after removing ZIP 4 and lopdf 0.38. | tool | zip-lopdf-upgrade/all-audits.json: main 5 to 1; diagnostic 1; other five 0. | Full locked package inventory; no yanked lookup. | passed |
| V5 | R2 | Compile native consumer with optional parser enabled and execute PDF/ZIP behavior checks. | tool | Native feature check passed; 375 LiteParse tests and 3 ZIP extraction smoke tests passed. | macOS aarch64; Windows/Linux installation execution remains outside this evidence. | passed |
| V6 | R3 | Compare follow-up baseline, vendor source, dependency records and read-only preflight. | tool | Only updater/lopdf closure changes; four unrelated resolver edge changes restored; source comparison and both read-only audits passed. | Root manifests, lock, deny source allowlist and vendored crate; no staging or commit. | passed |

## Decisions

| ID  | Date       | Decision                                                                                                                                            | Action    | Based on           | Reversal trigger                                |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------ | ----------------------------------------------- |
| D1  | 2026-10-22 | Update TLS patch versions, align Wasmtime at 49.0.4, evaluate ZIP 9 and upstream parent updates.                                                    | implement | O1, O2, O3, C1, G1 | Upstream constraints or incompatible APIs.      |
| D2  | 2026-10-22 | Disable registry yanked lookup for reproducible advisory scans after registry requests timed out; retain full vulnerability and unsoundness output. | diagnose  | O1                 | Registry available for a separate yanked check. |

| D3 | 2026-10-22 | Pin the official updater ZIP 9 fix and vendor the existing LiteParse release with only the lopdf dependency changed; add security regression tests and retain provenance. | implement | O4, O5, C1, G1 | Compatible upstream published releases allow removal of the Git pin and vendor patch. |

## Compatibility changes and review

ZIP 9 changes ZipFile::name to return ZipResult<Cow<str>>. A failing cargo check reproduced the old-call-site error in CLI info.rs. The update adapts ten existing Rust files: production callers propagate decode errors through their existing error types, while test-only inventory helpers unwrap names generated by their fixtures. Safe path, symlink and extraction-budget checks remain in place. CLI inventory, browser extension extraction and Tauri extraction tests now include Unicode filenames. No new source module was introduced.

Preflight dispatched the applicable read-only tauri-rust-reviewer and test-gap-auditor over only task paths. No actionable Rust regression or missing co-located tests was found. The scope wording finding in this ledger was corrected. Review suggestions: direct error-path and Unicode tests in every remaining ZIP consumer were not added; these branches are included in residual verification scope. No coverage run was requested or performed.

## Updates and audit results

| Dependency                        | Before   | After    | Scope                                                                       |
| --------------------------------- | -------- | -------- | --------------------------------------------------------------------------- |
| rustls                            | 0.23.45  | 0.23.46  | Main and diagnostic lockfiles; both manifests now require at least 0.23.46. |
| rustls-webpki                     | 0.103.15 | 0.103.16 | Main and diagnostic lockfiles.                                              |
| webpki-roots                      | 1.0.9    | 1.0.10   | Main and diagnostic lockfiles.                                              |
| webpki-root-certs                 | 1.0.9    | 1.0.10   | Main and diagnostic lockfiles.                                              |
| wasmtime / wasmtime-wasi          | 49.0.1   | 49.0.4   | Plugin runtime exact pins and matching Cranelift/Pulley/Wiggle packages.    |
| zip (direct workspace dependency) | 8.6.0    | 9.0.5    | Workspace manifest now selects major 9.                                     |

| Lockfile                                    | Vulnerability matches before | After |
| ------------------------------------------- | ---------------------------- | ----- |
| Cargo.lock                                  | 37                           | 5     |
| services/diagnostic-server/Cargo.lock       | 8                            | 1     |
| services/share-server/Cargo.lock            | 0                            | 0     |
| services/signaling-server/Cargo.lock        | 0                            | 0     |
| services/signaling-server/worker/Cargo.lock | 0                            | 0     |
| crates/cognia-plugin-template/Cargo.lock    | 0                            | 0     |
| plugins/wasm-example-formatter/Cargo.lock   | 0                            | 0     |

Counts are advisory/package matches, not distinct exploitable product paths. The raw scanner remains nonzero for the main workspace and diagnostic service because of the findings below. No ignore entry was added. Existing deny.toml exceptions were preserved.

## Initial remaining findings

The ZIP and lopdf entries below describe the initial remediation snapshot. They are resolved by the authorized follow-up recorded at the end of this ledger; RSA and maintenance warnings remain current.

- **zip 4.6.1**: RUSTSEC-2026-0367, RUSTSEC-2026-0368, RUSTSEC-2026-0369. The Windows-only Tauri updater depends on ZIP major 4 and invokes ZipArchive::extract. Latest stable updater 2.14.0 still requires ^4, so upgrading its parent does not remove the findings. Kept the original updater 2.13.2 to avoid an unrelated update. A patched upstream dependency or a separately reviewed updater migration is needed; changing the workspace ZIP version cannot override this major constraint.
- **lopdf 0.38.0**: RUSTSEC-2026-0187. Optional parse-liteparse → liteparse 2.15.1 → lopdf ^0.38; the fix starts at 0.42.0. Latest liteparse 2.16.0 retains ^0.38, so kept the original parent. This lockfile match does not establish that the optional feature is enabled in a deployed binary.
- **rsa 0.9.10**: RUSTSEC-2023-0071 in both affected lockfiles. RustSec lists no patched version. Existing deny.toml records that Cognia uses JWT verification/local signing rather than an exposed PKCS#1 v1.5 decryption oracle; that existing exception was not expanded or treated as a dependency fix.
- Main lockfile additionally retains **10 unmaintained-package warnings** (bincode, paste, proc-macro-error, rustybuzz, two ttf-parser versions, unsafe-libyaml, zbus_names, zvariant, zvariant_derive) and **one unsoundness warning** for glib 0.18.5, RUSTSEC-2024-0429. The latter has an existing Tauri/GTK3 ABI exception in deny.toml. These warnings are separate from the five vulnerability matches.

## Sources and reproducibility

All checks were performed on macOS aarch64 on 2026-10-22 with cargo-audit 0.22.2 and rustc 1.99.0. RustSec database: 1,348 advisories, commit 4b587f00996ebe5c05a73eaef105ef241e876414, last updated 2026-10-21. Initial registry yanked lookups repeatedly timed out; subsequent scans use --no-yanked and the same refreshed database. A transient worker baseline read raced with the database fetch; it was rerun successfully after the fetch completed. No advisory match was suppressed.

The current emSign advisories were issued on 2026-10-20, rather than newly issued on 2026-10-22. The latest advisory index checked during this task listed those as its newest entries.

- [RUSTSEC-2026-0381: webpki-roots](https://rustsec.org/advisories/RUSTSEC-2026-0381.html)
- [RUSTSEC-2026-0382: rustls-webpki](https://rustsec.org/advisories/RUSTSEC-2026-0382.html)
- [RUSTSEC-2026-0383: webpki-root-certs](https://rustsec.org/advisories/RUSTSEC-2026-0383.html)
- [Wasmtime aarch64 compiler advisory, fixed in 49.0.4](https://rustsec.org/advisories/RUSTSEC-2026-0379.html)
- [ZIP extraction advisory, fixed in major 9](https://rustsec.org/advisories/RUSTSEC-2026-0369.html)
- [lopdf recursion advisory, fixed in 0.42.0](https://rustsec.org/advisories/RUSTSEC-2026-0187.html)
- Parent constraints checked against downloaded Cargo manifests and the crates.io sparse index on 2026-10-22.

Local raw evidence is under .cache/security/2026-10-22/ (ignored): baseline lockfiles, before/after JSON, audit-summary.json, metadata and verification logs. The baseline is reproducible with cargo audit --no-fetch --no-yanked --file .cache/security/2026-10-22/baseline/Cargo.lock; current scans use the project lockfile path. These reports audit source dependency resolutions, not previously built or deployed artifacts.

## Verification commands

- cargo test --locked -p cognia-net --lib -j 1: **200 passed, 0 failed**, including HTTPS proxy/TLS tunnel behavior.
- cargo metadata --locked --no-deps --format-version 1 for the root and diagnostic service: **passed**.
- Initial six-consumer cargo check: **failed as expected for ZIP9 migration**, exposing fallible name access at CLI info.rs:261. Call sites were adapted after that result; this failure is not counted as successful validation.
- cargo check --locked --all-targets -p cognia-plugin-runtime -p cognia-cli -p cognia-codeserver -p cognia-local-browser -p cognia-observability -p cognia-github-runner -j 1: **passed**, 4m12s. One pre-existing unused-variable warning in cognia-sandbox-pool/src/providers/mod.rs:76 remains; no lint suppression was added.
- cargo test --locked -p cognia-github-runner --lib -j 1: **18 passed, 0 failed**, including encrypted pairing ZIP consumption.
- git diff --check on task paths: **passed**.
- Preflight read-only Rust and co-located-test audits: no remaining actionable findings. The dependency-only phase grew to include ZIP compatibility call sites based on the compile failure.

The successful test total is **218** (200 network + 18 runner); the all-targets check compiles tests but does not execute them. No full native app build, full plugin runtime suite, standalone diagnostic service build, Windows/Linux execution, or production deployment is claimed. Local disk was checked before and during compilation; the small runner test used a 180 MiB guard and completed before reaching it. Free space afterward was 207 MiB, so no further native compilation was started.

After freeing several GiB, remaining targeted verification commands are:

```sh
cargo test --locked -p cognia-cli --bin cognia commands::info::tests -j 1
cargo test --locked -p cognia-local-browser zip_extraction -j 1
cargo test --locked -p cognia-plugin-runtime --lib -j 1
cargo test --locked -p cognia-next --lib cli_bridge::handlers::tests::extract_zip_into -j 1
cargo check --locked --manifest-path services/diagnostic-server/Cargo.toml -j 1
```

## Residual risks

| ID  | Residual                                                                                                                              | From | Why still open                                                                                                                 | Next action                                                                                      | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------ |
| X1  | One main and one diagnostic vulnerability match remain after the ZIP/lopdf follow-up, plus maintenance/GLib warnings described above. | R1   | RSA has no patched release; no new advisory exception added. ZIP/lopdf constraints are resolved by the follow-up below.        | Migrate affected parents when patched and separately review the retained risk.                   | open   |
| X2  | Full plugin runtime, CLI inventory/browser Unicode execution and Tauri extraction tests remain unverified.                            | V2   | Only 207 MiB remained after successful focused checks. Direct ZIP name decoding error branches also lack specific regressions. | Free several GiB, then run the focused commands below; build/deploy acceptance remains separate. | open   |
| X3  | Previously built and deployed binaries retain their original dependencies.                                                            | M1   | This task updates source manifests and locks only.                                                                             | Build, validate and distribute updated binaries through the normal release flow.                 | open   |

## Outcome

| ID  | Signal                                                                                         | How / when measured                           | Result                                                                                              | Status |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| M1  | Current TLS advisory matches disappear and remaining Rust findings are explicitly inventoried. | Same database before/after audit, 2026-10-22. | All RUSTSEC-2026-0381/0382/0383 matches removed from all seven lockfiles; remaining findings below. | met    |

## ZIP and lopdf follow-up — 2026-10-22

The user explicitly requested updating ZIP to 9.0.5 and lopdf to 0.46.0 while
preserving concurrent edits. The original workspace ZIP was already 9.0.5;
the remaining vulnerable copies were owned by the updater and optional parser.

Changes:

- Raise the workspace ZIP minimum to 9.0.5. Pin tauri-plugin-updater 2.14.0 to
  official revision `11211c30e71796cd737280303244552bb7f70797`, which changes
  the Windows dependency to ZIP 9. The published 2.14.0 crate still uses ZIP 4.
  This parent update also changes minisign-verify 0.2.5 to 0.3.0. App callers
  remain compatible; official updater 2.14 additionally verifies on install
  and changes Linux AppImage handling. Only macOS compilation is validated.
- Add the official repository to deny.toml's Git source allowlist. No advisory
  ignore or capability exception changes. The manifest revision is immutable.
- Vendor the published LiteParse 2.15.1 crate under vendor/liteparse and redirect
  its existing optional dependency through the root Cargo patch. Upstream
  LiteParse 2.16.0 still requires lopdf 0.38; Cargo cannot satisfy that constraint
  with a direct lopdf 0.46 override. The only production change in the vendored
  crate is its normalized manifest requirement for lopdf 0.46.0. Two co-located
  regression tests cover XMP from bytes/files and a 10,380-level malicious
  Catalog. The original manifest, VCS metadata, upstream tests and Apache-2.0
  license are preserved; COGNIA-PATCH.md records provenance and removal criteria.
  PDFium remains 1.11.0 and Tesseract/default features remain disabled.

Validation:

- `cargo check --locked -p cognia-next --lib --features parse-liteparse -j 2`:
  passed in 3m33s. This compiles both the app's existing PDF adapter and new
  updater against the actual root lockfile, without changing source APIs.
- Isolated test manifest under `.cache/security/2026-10-22/zip-lopdf-upgrade/`
  points its lib directly at vendor/liteparse/src/lib.rs and reproduces the
  crate's published dependencies with lopdf 0.46.0 and defaults disabled.
  `cargo test --locked --offline --manifest-path <liteparse-probe/Cargo.toml>
--no-default-features --lib --target-dir target -j 2`: **375 passed, 0 failed,
  0 ignored**, including real PDFium extraction, AcroForm repair and both new
  regressions. This isolated test lock is distinct from the root application
  lock; the native consumer check above validates the root resolution.
- The first full test attempt failed only because the published crate omits
  `integration_tests_data/sample3.doc`. Retrieved the actual fixture from
  upstream revision ab8879623ee45a0b7a775d12b42a9a7ae9dab16b into ignored cache
  and reran all tests; no skip variable or assertion weakening. Fixture SHA-256:
  `58211ac149c4b05110cb95959f0f5f529333af5aea060d5a5baf096f531848b8`.
- ZIP 9.0.5 smoke harness invokes the updater's same ZipArchive::extract API:
  **3 passed** (Unicode MSI byte preservation, traversal rejection, external
  symlink rejection). This is real host extraction, not Windows installer
  execution, install/signature acceptance, or Linux AppImage installation.
- `cargo tree --locked --offline --target all -i zip` and the corresponding
  lopdf tree with `--features parse-liteparse` confirm only ZIP 9.0.5 and
  lopdf 0.46.0, including the Windows updater and optional parser edges.
- Final locked/offline native feature recheck: **passed**, 52.57s.
- `cargo clippy --locked --offline -p tauri-plugin-updater --lib -j 2`: **passed**,
  59.08s. LiteParse retains two upstream dead-code warnings; no suppression added.
- `cargo deny --locked --offline check sources`: **sources ok**. Targeted
  rustfmt and diff checks passed. Read-only Rust and wiring preflight found no
  actionable regression. Four unrelated wide-range lockfile edges changed by
  Cargo were restored to their captured baseline and accepted by locked checks.

Current advisory matches: main workspace **1** and diagnostic service **1**,
all `rsa 0.9.10 / RUSTSEC-2023-0071`; the other five lockfiles have **0**.
The three ZIP advisories and lopdf RUSTSEC-2026-0187 are removed. The 10
maintenance and one GLib unsoundness warnings remain; yanked status is excluded
as documented above. The audit process correctly remains nonzero for RSA.

Raw follow-up evidence, baseline snapshots, exact test manifests, outputs and
all seven JSON scans are under `.cache/security/2026-10-22/zip-lopdf-upgrade/`.
No full app test suite, packaging, Windows/Linux execution or deployment is
claimed. Concurrent edits were preserved; nothing was staged or committed.

Sources: [official updater pinned manifest](https://github.com/tauri-apps/plugins-workspace/blob/11211c30e71796cd737280303244552bb7f70797/plugins/updater/Cargo.toml),
[lopdf advisory](https://rustsec.org/advisories/RUSTSEC-2026-0187.html),
[LiteParse source snapshot](https://github.com/run-llama/liteparse/tree/ab8879623ee45a0b7a775d12b42a9a7ae9dab16b/crates/liteparse).
