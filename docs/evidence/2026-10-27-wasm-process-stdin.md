# Evidence ledger: WASM process stdin

- Status: verifying
- Lane: standard
- Created: 2026-10-27
- Updated: 2026-10-27
- Related: docs/reports/2026-10-26-rust-dependency-governance.md

## Original request

> 把 WASM 插件进程接口缺少的 stdin 支持补上以及其他缺少的功能，不能影响现有插件，再用 formatter 做真实测试，确

## Follow-up request (2026-10-27)

> 把两个协议版本断言失败也修复掉，再用真实 Tauri 界面验证 formatter 的配置更新、权限撤销和停用卸载流程，确保不影响现有插件

Acceptance: reproduce and fix both stale assertions without changing runtime
protocol behavior, pass the complete plugin runtime suite, drive formatter
configuration and permissions plus disable/uninstall through the real Tauri
renderer, inspect native state/results, and recheck an unchanged old component
and existing plugin inventory. Capture screenshots/logs and stop the owned run.

## Knowledge

| ID  | Statement                                                                                                                  | State    | Basis                                                                                                                                                                                    | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Before this change, process.exec had no input channel, waited before draining pipes, and lacked lifecycle cancellation.    | Verified | Preserved task baseline under .cache/wasm-process-stdin/2026-10-27/baseline; pipe-regression-before.log reproduces timeout on full output pipes.                                         | -          |
| O2  | The original formatter source, WIT 0.2.0, component and bundle were preserved before contract changes.                     | Verified | old-formatter/, old-formatter-build.log and installed-old/ under the evidence root on 2026-10-27.                                                                                        | -          |
| C1  | Existing plugin binaries, process.exec signature and exec-options/result layouts must remain usable.                       | Verified | Explicit user constraint on 2026-10-27.                                                                                                                                                  | -          |
| G1  | Format real Rust source through a compiled WASM formatter and production host; correct adjacent execution gaps.            | Agreed   | Explicit user instruction on 2026-10-27.                                                                                                                                                 | -          |
| H1  | Additive exec-with-stdin preserves the tested v0.2.0 binaries without changing existing exec types.                        | Verified | real-formatter-final.log: unchanged old template lifecycle, original formatter activation, old-WIT exec guest calling native printf; contract layout unit test. macOS arm64, 2026-10-27. | C1         |
| O3  | Retained stores need live process grants, and the frontend must mirror grant/revoke changes to the native ledger.          | Verified | permission-ui-before.log reproduces missing writes; real formatter permission/allowlist tests observe changes without reactivation.                                                      | O1         |
| O4  | Failed configuration activation must preserve the prior store; pending initialization must not resurrect a stopped plugin. | Verified | real-formatter-final.log exercises rejected config, pending-init deactivate/unload/supersede/abort; atomic token and Arc cleanup regression tests pass.                                  | C1         |
| O5  | The two protocol failures were stale test literals, while runtime values already came from canonical catalog 1.3.0.        | Verified | protocol-contract-before.log and protocol-python-before.log reproduce failures; protocol-runtime-tests.log: 638 passed, 0 failed, 1 ignored after cfg(test)-only changes.                | C1         |
| O6  | Independent permission views did not rerender after grant/revoke in another mounted view.                                  | Verified | gui/permission-view-before.log reproduces stale derived grants; gui/permission-unit-final.log: 82 passed after mutation subscriptions and disposal tests.                                | O3         |
| G2  | Exercise formatter configuration, revocation, disable/uninstall through the real Tauri UI and retain existing plugins.     | Agreed   | Explicit follow-up request on 2026-10-27.                                                                                                                                                | C1         |

## Problem frame

Complete existing WASM process execution: binary input, concurrent output,
bounded waits, live permission enforcement and lifecycle cancellation. Preserve
existing call layouts and execute old compiled components as compatibility
checks. Use the real formatter to compare tool and workflow output directly
against native rustfmt. Adjacent fixes cover configuration propagation, pending
initialization and permission UI writes; no unrelated plugin platform is added.

Evidence root: `.cache/wasm-process-stdin/2026-10-27/`. The `baseline/` directory
predates this task; `final-source-hashes.json` identifies the tested owned files.
The working tree contains extensive concurrent edits outside this task.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                          |
| ------------ | ------ | ------------------------------------------------------------------------------------ |
| scale        | medium | WIT mirrors, process runner/lifecycle, formatter, config and permission transport.   |
| technical    | high   | Concurrent I/O, cancellation while holding a Store, transactional initialization.    |
| coupling     | high   | Published contract and compiled guest compatibility.                                 |
| requirement  | medium | Other missing functionality bounded to concrete execution/config/permission gaps.    |
| verification | medium | Real compiled guests and native host on macOS; separate GUI and platform boundaries. |
| risk         | high   | Process permissions and old binary compatibility.                                    |

## Risks

| ID  | Risk (impact)                                                    | Severity | Source | Claim                                                                                                                    | Refuted by                                                 |
| --- | ---------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| R1  | ABI or lifecycle changes break existing plugins.                 | high     | C1, O4 | Keep original exec types, error wording and legacy output-size behavior; preserve prior valid instance on failed config. | Old binary fails or stale cleanup removes a replacement.   |
| R2  | Pipes deadlock or child survives cancellation.                   | high     | O1     | Concurrent stdin/stdout/stderr stay under the call deadline and lifecycle cancellation.                                  | Pipe-fill stalls or timeout/stop/abort leaves child alive. |
| R3  | Execution bypasses current consent or leaks ambient environment. | high     | O3     | Live grants and allowlist checked before spawn and while running; env remains cleared.                                   | Revoked call executes or child inherits HOME.              |
| R4  | Formatter appears to pass without doing real formatting.         | medium   | G1     | Compare real component output, stderr and exit code against direct native rustfmt.                                       | Mocked guest or any byte differs.                          |

## Verification obligations

| ID  | Risk           | Method                                                                                                                                                                                    | Independence | Evidence                                                                                                                                                                                                                                | Coverage                                                                                                                                                                                                              | Status  |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1             | Old compiled components and unchanged layout regression tests.                                                                                                                            | real-env     | real-formatter-final.log; wasm-tests-final.log (177 passed); frozen API and four WIT mirror gates passed.                                                                                                                               | Unchanged pre-existing v0.2.0 template: load/init/tool/event/workflow/deactivate/unload. Original formatter links/initializes; old exec guest executes Unicode printf.                                                | passed  |
| V2  | R2             | Real pipe-fill, binary input, EOF, nonzero exit, cancellation, deadlines and child reaping.                                                                                               | real-env     | wasm-tests-final.log; real-formatter-final.log. Deactivate 2ms, unload 3ms, timeout 953ms after child detected with a 1000ms call budget, abort 4ms, revoke 7ms; all owned PIDs gone.                                                   | Both imports; initialized and pending-init guests; rejected config, supersede, abort, repeated activation.                                                                                                            | passed  |
| V3  | R3             | Gate ordering, environment and size-bound tests; native revocation checks; independent review.                                                                                            | tool         | wasm-tests-final.log; ui-tests-final.log (403 passed); real-formatter-final.log. Auditors found no remaining scoped defects.                                                                                                            | Permission and allowlist denial, expiry-preserving UI requests, failed persistence, explicit env, 4 MiB input and 8 MiB per-stream limits for new API.                                                                | passed  |
| V4  | R4             | Build actual formatter with Cognia CLI; compare tool/workflow calls against direct rustfmt.                                                                                               | real-env     | new-formatter-build-final.log; formatter-unit-tests.log (4 passed); real-formatter-final.log (all cases passed).                                                                                                                        | Five inputs times two exports: valid code, Chinese/emoji, function body, empty source and syntax error (exit 1). Byte-for-byte stdout/stderr and equal exit code.                                                     | passed  |
| V5  | R1, R2, R3     | Focused Rust/CLI tests, Tauri-enabled compilation, formatting, contract gates and independent preflight.                                                                                  | tool         | wasm-tests-final.log (177 passed); cli-tests-verified.log (475 unit + 15 bundle + 127 CLI tests passed); tauri-host-check.log; clippy.log; rustfmt-check.log; prettier-check.log; lint-scoped.log; wit-gate-tests.log.                  | Production WASM host and updated config/permission code compile. Clippy exits 0 with warnings only in unchanged node_runtime/installer/cogpack_transfer paths. No remaining Rust, test-gap or wiring review findings. | passed  |
| V6  | R1, R3         | Full runtime tests and repository type/lint gates.                                                                                                                                        | tool         | protocol-runtime-tests.log now reports 638 passed, 0 failed, 1 ignored. Broader typecheck/lint status remains recorded separately; see gui/typecheck-followup.log.                                                                      | Broader repository acceptance; failures are retained rather than assertions weakened or foreign work edited. Static export, i18n lint and sort checks pass.                                                           | failed  |
| V7  | R1, R2, R3, R4 | Real Tauri UI: install test guests, save/change formatter executable, revoke/regrant process permission, disable/re-enable and uninstall; compare native results and old plugin behavior. | real-env     | Real app built and launched: agent-debug API v3, main URL http://localhost:3000/plugins. gui/boot-progress.json remains at workspace preparation; CUA confirmed the Mac is locked and automatic unlock failed. Manual unlock requested. | macOS arm64 main webview, production manager/IPC/Wasmtime and real rustfmt.                                                                                                                                           | blocked |

## Decisions

| ID  | Date       | Decision                                                                                                                                                                                   | Action    | Based on       | Reversal trigger                                                                                   |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------------- | -------------------------------------------------------------------------------------------------- |
| D1  | 2026-10-27 | Preserve original formatter and compiled binary; reproduce pipe-fill failure before replacing the runner.                                                                                  | diagnose  | O1, O2, C1     | Baseline already drains pipes concurrently.                                                        |
| D2  | 2026-10-27 | Introduce exec-with-stdin in API 0.2.1; keep original exec records, null stdin, output-size behavior and ordinary error wording.                                                           | implement | C1, H1         | Old binary or legacy behavior regression.                                                          |
| D3  | 2026-10-27 | Use async I/O and cancellation reachable without locking the running Store; atomically publish init tokens and compare/remove retained instances.                                          | harden    | O1, O4         | Deadlock, surviving child, stopped init resurrects state, or stale cleanup deletes newer instance. |
| D4  | 2026-10-27 | Refresh native configuration transactionally, observe live process grants, and persist UI permission changes before reflecting success. Preserve existing grant expiry/provenance.         | implement | O3, O4, C1     | Configuration failure destroys old instance or existing grant is silently extended.                |
| D5  | 2026-10-27 | Keep formatter argv fixed, use binary stdin and an optional configured native rustfmt path without inheriting ambient environment.                                                         | implement | G1, C1         | Arbitrary caller args reach host or source differs from direct rustfmt.                            |
| D6  | 2026-10-27 | Repair stale test expectations without changing the runtime protocol, and notify all mounted permission consumers on mutations. Reading permissions must not notify or cause render loops. | harden    | O5, O6, C1, G2 | Version serialization diverges from catalog, or subscribers leak after disposal/clear.             |

## Residual risks

| ID  | Residual                                                              | From               | Why still open                                                                                                                                                                             | Next action                                                                                                              | Status |
| --- | --------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| X1  | Full runtime test suite is not green.                                 | V6                 | Fixed stale cfg(test) literals using canonical catalog comparisons; full runtime now has zero failures.                                                                                    | None; full suite rerun completed on 2026-10-27.                                                                          | closed |
| X2  | Repository typecheck and lint are not green.                          | V6                 | Errors occur in untouched runtime badge/options, context workbench, chat tests, Discord avatar and generated native-agent CJS paths. This task's scoped ESLint and Tauri compilation pass. | Owning concurrent changes resolve their diagnostics, then rerun pnpm typecheck and pnpm lint.                            | open   |
| X3  | GUI and other operating systems have no real execution evidence here. | V1, V2, V3, V4, V7 | Current Mac is locked (CUA reported automatic unlock failure). Real main window is at workspace preparation; formatter UI flows have not run. Linux/Windows remain untested.               | User manually unlocks Mac, then continue V7 in the owned Tauri run. Other platforms require their own native acceptance. | open   |

## Outcome

| ID  | Signal                                                | How / when measured                                                                                 | Result                                                                                                                                         | Status  |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| M1  | Formatter actually formats through WASM.              | 2026-10-27, real built guest and native host on macOS arm64, native toolchain rustfmt, env cleared. | All 10 comparisons match direct rustfmt including syntax-error stderr and exit 1.                                                              | met     |
| M2  | Existing tested binaries and lifecycle remain usable. | Real old components, plus native cancellation and pending-init probes.                              | Old v0.2.0 binaries link; original exec runs; stop/unload/timeout/abort/revoke reap controlled children; rejected config keeps prior instance. | met     |
| M3  | Repository-wide checks are green.                     | Full runtime tests, pnpm typecheck and pnpm lint.                                                   | Scoped checks and full runtime tests pass; broader repository gates remain blocked as recorded in X2.                                          | not-met |

## Implementation and reproduction

- Canonical WIT: `src-tauri/wit/cognia-plugin.wit`; SDK/template/example mirrors synchronized. Frozen v0.1 files unchanged.
- Shared runner: `crates/cognia-plugin-runtime/src/wasm/capabilities/process.rs`; both WIT imports route through it. New operation accepts binary stdin, closes EOF, drains stdout/stderr concurrently, reports size errors without truncation, and kills/reaps on errors or cancellation. Normal successful legacy subprocess behavior is retained.
- Host lifecycle: `wasm/commands.rs`, `host.rs`, `store.rs` and `engine.rs`. Epoch ticks outlive Tokio runtimes; wall-clock deadlines cover guest calls. Failed init/config does not replace an active instance. Committed tokens cannot remain pending; cleanup uses an atomic Arc identity check.
- Renderer configuration: `lib/plugin/core/wasm-loader.ts` and `manager.ts` use the existing activate command only for enabled WASM plugins. Permission hook mirrors native grant/revoke, honors disabled runtime grants, and does not extend existing temporary grants.
- Formatter keeps its sandboxed source file demonstration, passes source over stdin, and optionally accepts `rustfmtProgram`. A rustup shim may fail with an empty environment; configure the absolute native path returned by `rustup which rustfmt`. Do not automatically allow rustup or inherit HOME/PATH.
- Original formatter activation succeeds but its original call still fails to spawn bare rustfmt on this host. This is reported separately from the upgraded formatter's passing execution; activation alone is not claimed as functional formatting.

Run the production host probe with:

```sh
CARGO_TARGET_DIR="$PWD/target" cargo build --locked --offline \
  --manifest-path .cache/wasm-process-stdin/2026-10-27/host-probe/Cargo.toml -j 2
target/debug/cognia-wasm-process-probe \
  .cache/wasm-process-stdin/2026-10-27 \
  "$(rustup which rustfmt)"
```

The activation probe is explicitly derived from the formatter with an optional
init-time process call; old-formatter remains unchanged. Source fixtures,
bundles, PID scripts and logs remain under the evidence root. Some task-only
compiler intermediates were removed after disk exhaustion; guest source, Wasm,
ZIPs and evidence were retained. CLI testing initially hit disk exhaustion,
then a macOS `Code Signature Invalid` / `CODESIGNING Invalid Page` on its local
test executable. Re-signing that generated test binary ad hoc allowed the
standard Cargo test command to run successfully; application signing policy
and source were unchanged.

An earlier runtime test invocation aborted in Wasmtime's Mach exception
handler; subsequent complete WASM and full-runtime runs did not reproduce it.
The original log and OS diagnostic were retained; no unsupported root-cause
claim or exception-handler change is made.

Three independent read-only audits (Rust lifecycle, test gaps and wiring) found
and prompted fixes for pending-token publication, stale-instance cleanup and
permission-request expiry preservation. Final incremental reviews reported no
remaining scoped code findings. No coverage, commit, push or deployment ran.

## Tauri follow-up progress

- Complete plugin-runtime suite after the two assertion repairs: **638 passed, 0 failed, 1 ignored**. Only cfg(test) code changed in contract.rs and python/commands.rs.
- Cross-view permission refresh regression first failed, then passed. Related UI/manager/loader checks: **408 passed**; final hook/guard checks: **82 passed**. Scope-specific ESLint and formatting pass.
- Probe plugin IDs are wasm-gui-formatter-probe and wasm-gui-legacy-probe. Their guest binaries are byte-identical to the tested formatter 0.2.1 and unchanged old template 0.2.0. Only test install identity/display metadata and minimum-host metadata differ; no existing plugin was replaced. No probe installation has occurred yet.
- First Tauri run built and launched but later received a graceful shutdown signal during initial navigation. Its log is retained. Second owned run is held in foreground; current session d7765d3c-08d1-43a4-a96f-54c7fe65c2b1, app PID 82991. The frontend needed one explicit navigation after initial cold loading; native windows then reports main visible at /plugins, with helper API v3.
- The captured startup image taken while main was hidden showed the foreground desktop, so it is excluded from UI acceptance. Structured snapshots show workspace preparation, not the formatter. CUA then explicitly reported: “The Mac is locked and automatic unlock could not unlock it. Ask the user to unlock the Mac manually before continuing.” The user was asked to unlock; V7 remains blocked, not passed.

The follow-up repository typecheck ran and failed with 11 diagnostics, all in
untouched context-workbench tests, chat tests and Discord avatar source/tests.
No hook/permission-guard diagnostics were emitted. This does not replace the
blocked real-interface obligation V7.
