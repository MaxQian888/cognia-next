---
title: ADR-0067 — src-tauri crate decomposition & build-speed program
description: "The Tauri backend is 170k LOC of Rust in a single crate (`app_lib`), so every edit recompiles and relinks the whole tree. This ADR records the research verdict — decomposition is highly feasible because every heavy dependency has a single owner module, command functions are already isolated into thin adapters, and cross-module coupling is shallow — and proposes a layered workspace (`cognia-core` / `cognia-telemetry` / per-subsystem library crates / thin app shell), a ranked set of zero-refactor compile-speed wins (lld linker, sccache, dev-profile debuginfo, AV exclusions, feature-gating), and a low-risk phased migration that lands quick wins first and extracts one leaf crate as the reusable template."
---

# ADR-0067 — src-tauri crate decomposition & build-speed program

**Status**: Accepted (2026-07-13) — **Tier A landed** (7 crates); **Tier B + follow-up landed** (13 more crates, 2026-07-13); app shell (Tier C) remains
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: the existing workspace split pattern (`crates/cognia-cli`, `crates/cognia-sandbox-runner` — the latter explicitly extracted "so `cargo check -p cognia-sandbox-runner` compiles only a few crates instead of the whole Tauri tree"), the release/test profile overrides in the root `Cargo.toml`, and the per-module `commands.rs` "thin Tauri adapter" convention already present across the backend.

## Context

The Tauri backend has grown into a single monolithic library crate. This is the dominant drag on developer velocity and CI cost, and the numbers are unambiguous:

| Metric | Value | Consequence |
| --- | --- | --- |
| Rust source | **170,517 LOC**, all in one crate (`app_lib`) | Editing any one file recompiles **and relinks** the whole crate |
| Top-level modules | 42 directories + 23 loose files under `src/` | In-crate "pseudo-layering" the compiler cannot parallelise |
| `Cargo.lock` packages | **1,331** | Clean-build weight |
| Duplicate-versioned crates | **130** (`glam×18`, `windows×6`, `nix×5`, `hashbrown×5`, …) | Same crate compiled N times — pure waste |
| Largest module | `companion_api` — **28,162 LOC / 56 files**, depends on 13 sibling modules | God-orchestrator |
| Linker / build cache | **none** — `.cargo/config.toml` sets only `tokio_unstable` | No `lld`/`mold`/`sccache` configured |

Two second-order symptoms already show up in the tree:

- The **test profile** was forced to `debug = "line-tables-only"` because a full-debuginfo build of the giant single test binary makes "LLVM run out of memory on Windows (`rustc-LLVM ERROR: out of memory`)" (see the comment in the root `Cargo.toml`). This is a monolith symptom — a smaller codegen unit per crate makes it disappear.
- The team **already reaches for isolated crates** when a fast check loop matters (`cognia-sandbox-runner`), proving the pattern is understood and welcome; it simply hasn't been applied to the main tree.

### Why the monolith is safe to break up

Three structural facts (measured, not assumed) make decomposition unusually low-risk:

**1. Every "compile monster" has a single owner module.** Extracting one module isolates one heavy dependency:

| Heavy dependency | Sole owner module | Notes |
| --- | --- | --- |
| `wasmtime` (cranelift — heaviest in the tree) | `plugin_api` | |
| `webrtc` (~50 transitive deps, pulls `glam×18`) | `companion_api` | |
| `matrix-sdk-crypto` + `matrix-sdk-sqlite` + `ruma` | `connectors` | E2EE stack |
| `qdrant-client` | `vector` | |
| `git2` (`vendored-libgit2` → **C compile**) | `git` (+ `twin`) | |
| `portable-pty` | `terminal` | |
| `uiautomation` + `enigo` (windows-rs UIA) | `automation` | |
| `oar-ocr`/`ort`/`ocrs`/`rten`, `bollard`, `liteparse` (PDFium) | `ocr` / `external_agent` / `parse` | **already `optional` + feature-gated** ✅ |

**2. Command surface is already a thin adapter.** `#[tauri::command]` functions are concentrated into a single file per subsystem (`git` = 61 cmds in 1 file, `vector` = 33/1, `external_agent` = 22/1, `browser` = 21/1, `scheduler` = 18/1). Each module is therefore *pure logic (many files) + one `commands.rs` (thin Tauri shell)* — exactly the shape crate extraction wants. Tauri supports `#[tauri::command]` defined in any crate and referenced by path in `generate_handler!`, so the command shells can move with their logic or stay app-side.

**3. Cross-module coupling is shallow.** Most modules are leaves (`agents`, `github`, `twin`, `skills`, `pet_window`, `remote_control`, `wallpaper`, `capture` — zero sibling deps) or depend only on a small telemetry cluster (`perf`/`crash`/`logging`). The only true hub is `companion_api` (13 sibling deps), which is the app-level orchestrator and belongs in the app shell by design.

The measured coupling also exposes **three circular clusters** that must be extracted as units (or have their cycles broken):

- `logging ↔ crash`, plus `perf → crash`, `hooks → crash` → the **telemetry** cluster
- `automation ↔ sandbox ↔ cua_sandbox` → the **automation** cluster
- `scheduler ↔ workflow ↔ timing` → the **scheduling** cluster

## Decision

Adopt a **layered Cargo workspace** and a **ranked build-speed program**, executed in a phased, concurrency-safe order. No behavior changes; this is a structure + toolchain program.

### Target architecture

```
Layer 2 — app shell  (stays in src-tauri, thin)
  lib.rs assembly · generate_handler! · .manage(State) · plugin init
  companion_api (orchestrator + webrtc) · window/tray/menu/setup hooks

Layer 1 — pure-logic subsystem crates (each isolates one heavy dep)
  cognia-plugin-runtime (wasmtime, 15k)   cognia-connectors (matrix, 6k)
  cognia-vector (qdrant, 7k)   cognia-git (libgit2, 5k)   cognia-ocr (2k)
  cognia-automation +sandbox +cua (UIA, 22k)   cognia-terminal (pty, 5k)
  cognia-subscription (7k)     cognia-scheduling +workflow +timing (10k)

Layer 0 — foundation (no tauri)
  cognia-core: command_error · fs_atomic · secret_store · proxy_config · shared utils
  cognia-telemetry: logging + crash + perf (the cyclic cluster, extracted together)
```

### Extraction tiers (ordered by risk)

**Tier A — clean leaves (depend only on Layer 0).** No dependency inversion needed:
`vector`, `git`, `ocr`, the `automation`/`sandbox`/`cua_sandbox` cluster, the `scheduler`/`workflow`/`timing` cluster.

**Tier B — needs dependency inversion first.** These have an *upward* dependency on an app-layer module that must be replaced by a trait defined in the crate and implemented in the shell:
`connectors` (→ `companion_api`), `terminal` (→ `cli_bridge`), `subscription` (→ `claude`), `plugin_api` (→ `claude`, `connectors`).

**Tier C — stays in the app shell.** `companion_api` (webrtc, 13-way hub), window/tray/menu/setup, `lib.rs` wiring, `files.rs`.

### Compile-speed measures (ranked by ROI)

**W1 — Zero-refactor toolchain wins (do first, isolated commits):**
1. **`lld` linker.** Add `rustflags = ["-Clink-arg=-fuse-ld=lld"]` (Windows ships `rust-lld`). The relink step of a 170k-LOC crate runs on every incremental build; lld typically cuts it 30–50%.
2. **`sccache`** via `RUSTC_WRAPPER` — caches the 1,331-dep compile; large wins on CI, fresh checkouts, and branch switches.
3. **AV exclusion** for `target/` and `~/.cargo/` on Windows — Defender scanning every `.rlib`/`.o` is a hidden 20–40% incremental tax.
4. **dev-profile debuginfo:** the `dev` profile is still `debug = 2`; add `[profile.dev] debug = "line-tables-only"` + `split-debuginfo = "unpacked"` to shrink incremental compile (the `test` profile already does this to dodge the LLVM OOM).
5. **Baseline first:** run `cargo build --timings` + `cargo tree -d` once to record the true critical path before/after.

**W2 — Structural (the real fix):** the Tier-A/B extractions. Editing `cognia-git` then recompiles ~5k LOC + a small relink instead of 170k LOC; independent crates compile in parallel; the LLVM-OOM workaround becomes unnecessary.

**W3 — Feature-gating (already half-done):** gate `webrtc` behind a `companion-wan` feature and `matrix-sdk` behind a `connectors-e2ee` feature so developers not touching connectivity skip ~50 deps (and `glam×18`). OCR/docker/PDFium are already gated ✅.

**W4 — Dedup:** after `cargo tree -d`, collapse `glam`/`windows`/`nix` duplicates with `cargo update --precise` where semver allows. Marginal but real.

## Migration plan

Each step is an independent commit, gated by `cargo test --manifest-path src-tauri/Cargo.toml` + a `pnpm tauri build` smoke:

1. **W1 quick-win batch** — touches only `.cargo/config.toml` + root `Cargo.toml` profiles; almost no module code, lowest conflict surface against concurrent WIP.
2. **Extract `cognia-telemetry`** (logging + crash + perf) — the shared base every leaf needs; break the `logging ↔ crash` cycle here.
3. **Extract `cognia-core`** (foundation) — error types, `fs_atomic`, `secret_store`, `proxy_config`.
4. **Extract `cognia-vector`** (Tier A, 7k, isolates qdrant) — the **template PR**: proves "library crate defines `#[tauri::command]`, app references it in `generate_handler!`" end-to-end.
5. Clone the template for `cognia-git` → `cognia-ocr` → the `automation` cluster → the `scheduling` cluster.
6. Do the **Tier-B** dependency inversions, then extract `connectors`, `terminal`, `subscription`, `plugin_api`.

## Implementation status (Tier A — landed 2026-07-13)

Seven crates extracted from `app_lib`, each an independent commit gated by `cargo test -p <crate>` +
`cargo check --manifest-path src-tauri/Cargo.toml`. The final layout replaced the planned
`cognia-telemetry` with a narrower `cognia-instrument` (span registry only — `perf`/`crash`/`logging`
stayed app-side, as only `perf::guard` was a leaf dependency) and folded `command_error` into
`cognia-core` alongside `fs_atomic`:

| Crate | What moved | Isolates | Tests |
| --- | --- | --- | --- |
| `cognia-core` | `fs_atomic` + `command_error` (foundation, no tauri) | — | 18 |
| `cognia-instrument` | `perf/{span,registry}` (process-global span registry) | — | 12 |
| `cognia-git` | `git/` (Source Control, ADR-0038) | `git2` / vendored-libgit2 (C) | 106 |
| `cognia-ocr` | `ocr/` + the 5 `ocr-*` features | `ocrs`/`rten`/`oar-ocr`/`ort` (ONNX) | 43 |
| `cognia-vector` | `vector/` + `CredentialStore` inversion | `qdrant-client` + `sqlite-vec` | 100 |
| `cognia-automation` | `automation`+`sandbox`+`cua_sandbox` cluster | `uiautomation`/`enigo`/`xcap` | 326 |
| `cognia-scheduling` | `scheduler`+`workflow`+`timing` cluster | `cron` | 108 |

**Key techniques proven:** the "shim + re-alias" pattern (`mod X;` → `pub use cognia_X as X;`) kept the
`generate_handler!` list and every `crate::X::…` reference unchanged; `#[tauri::command]` at a **library
crate root** collides in the macro namespace (E0255), so ocr's commands were kept in a `native` submodule
and referenced via `ocr::native::…`; the shared `CredentialStore`/`perf`/`fs_atomic` seams were inverted or
re-exported rather than duplicated; and the `command_error ↔ scheduler` cycle was broken by relocating
`impl From<SchedulerError> for CommandError` into the scheduling crate (orphan-rule OK). `cognia-automation`
needed a `build.rs` embedding the Common-Controls v6 manifest into its **test** binary (tauri→muda/rfd
statically import `TaskDialogIndirect`).

**Measured win** (Windows dev box, warm cache): `app_lib` was one ~170k-LOC crate, so a cold rebuild of it
took **~4m08s** and any edit re-ran that crate's whole codegen. After extraction `app_lib` is ~90k LOC and
the ~80k LOC of subsystems are separately-cached rlibs: the heavy per-crate codegen (git2/vendored-libgit2,
qdrant, ONNX, uiautomation) is no longer part of an `app_lib` edit. Per-crate loops are now seconds —
`cargo test -p cognia-git` = **12s**, `-p cognia-automation`'s 326 tests run in **~2s** after compile — and a
full `cargo check` of the whole tree after touching one extracted crate is **~41s** (vs. re-checking the
monolith). ~726 crate-level unit tests pass; `app_lib` `cargo check` is green after every extraction. The
final app-binary **link** was not re-run locally (the dev disk sat at ~5–8 GB free, and a full debug link of
the workspace needs more) — CI / `pnpm tauri build` performs it; `cargo check` + all-crate builds cover
everything short of LLVM codegen + link.

**Not done this round (deferred):** the W1 build-speed config (lld linker, `[profile.dev]` debuginfo,
sccache) and W3 feature-gating — the user opted to leave the default build untouched; and **Tier B**
(`connectors`/matrix-sdk, `terminal`, `subscription`, `plugin_api`/wasmtime) which needs the dependency
inversions above and is gated on review.

## Implementation status (Tier B + follow-up — landed 2026-07-13, macOS session)

Thirteen more crates extracted (~58.5k LOC), one commit per crate, each gated by
`cargo test -p <crate>` + `cargo check -p cognia-next` (test failures cross-checked against the
pre-move `app_lib` test binary — every failure reproduced pre-move, i.e. pre-existing macOS/platform
failures, none introduced). `app_lib` is now **65,780 LOC** (from ~113k post-Tier-A and 170k
pre-ADR). The macOS baseline also surfaced a Tier-A gap: `cognia-scheduling` was missing the
mac-only `dirs`/`libc` deps (extracted on Windows where `scheduler/macos.rs` never compiles) — fixed.

| Crate | LOC | What moved / isolates | Inversion needed |
| --- | --- | --- | --- |
| `cognia-secrets` | 1.2k | `secret_store` + `keyring_secrets` + `api_key`; keyring + aes-gcm | none — command shells stay app-side; `test-inmemory` feature replaces the `cfg(test)` in-memory global (cfg(test) does not cross crates; dependents enable it from dev-deps) |
| `cognia-net` | 2.1k | `proxy_config` (state/detect/wsproxy); reqwest kept off `cognia-core` | none — `proxy_config/` stays as app-side facade with the command shells |
| `cognia-terminal` | 4.8k | terminal subsystem; `portable-pty` | `set_managed_cli_dirs_provider` (cli_bridge registry), registered in `run()` |
| `cognia-subscription` | 6.4k | vault + anthropic/codex/opencode providers (ADR-0025) | none — the 17-command top-level IPC surface stays app-side (owns the sidecar-restart seam) |
| `cognia-connectors` | 6.1k | webhook/WS ingress, sigverify, Matrix E2EE stack | `BusEventEmitter` impl (its one construction site) relocated to `companion_api::server` behind the crate's own `EventEmitter` trait |
| `cognia-plugin-runtime` | 15.2k | plugin runtime; **wasmtime/cranelift** | `set_sidecar_dir_resolver` (claude::sidecar), registered in `run()`; canonical WIT stays at `src-tauri/wit/` (bindgen uses a relative path — the plugin-sdk sync/gate scripts depend on that location) |
| `cognia-skills` | 2.1k | skills scan/install/registry | none (zero coupling) |
| `cognia-tts` | 0.9k | Edge TTS, provider keyring, proxied fetch | none |
| `cognia-remote-control` | 2.0k | LAN control API primitives | none |
| `cognia-gateway` | 6.6k | OpenAI-compatible local gateway | none (reuses cognia-remote-control) |
| `cognia-ccswitch` | 2.4k | provider-relay switcher | none (uses cognia-subscription discovery) |
| `cognia-mcp-server` | 3.9k | embedded MCP server (streamable HTTP) | none (uses cognia-automation dispatcher) |
| `cognia-external-agent` | 4.9k | exec backends; **bollard**/**kube** behind crate features (`container-exec`/`k8s-exec` now forward from app_lib) | `BusAgentEmitter` impl relocated to `companion_api::rpc` behind the crate's `AgentEventEmitter` trait; env-mutating tests got a crate-local lock replacing the borrowed `ws_bridge` test lock |

**What deliberately stays app-side (Tier C):** `companion_api` (28.2k — the orchestrator hub, per
Non-goals), `fleet` (5.7k — tray/window/monitor coupling), `claude` (3.1k — sidecar lifecycle wired
to hooks/companion_api/api_key), `cli_bridge` (2.7k — depends on companion_api), the
`logging`/`crash`/`perf` telemetry remainder (5.3k — tauri/app wiring around the extracted
`cognia-instrument` core), windowing/app shell (`pet_window`, `tray`, `menu`, `shortcuts`,
`browser` — the embedded-webview pane rides tauri's unstable API, `window_*`), `headless`/`bin`
assembly, the facade modules holding command shells (`subscription/commands.rs`, `proxy_config/`,
`keyring_secrets.rs`), and sub-1k leaves (`agents`, `github`, `twin`, `parse`, `wallpaper`,
`capture`, `canvas`, `plugins`, `a2ui_bridge`) where a workspace member's overhead outweighs the
compile-unit win. `files.rs` (2.2k) and `settings.rs` are app-level by design.

**Gates run:** per-crate suites (≈1,100 tests across the 13 new crates), targeted app_lib suites
over every moved seam, `cargo check --workspace` green (0 errors), and
`cargo check -p cognia-next --features container-exec` for the feature-forwarding path. As with
Tier A, the final app-binary link is covered by CI / `pnpm tauri build`, not re-run locally.

## Consequences

- **Dev inner-loop:** a change in one subsystem no longer recompiles the other 165k LOC; app-shell glue edits no longer recompile vector/plugin/automation.
- **Parallelism:** independent crates compile concurrently; CI wall-clock drops further with `sccache`.
- **LLVM OOM retired:** per-crate codegen units are small enough that the `test`-profile debuginfo workaround is no longer load-bearing.
- **Cleaner layering:** the three cyclic clusters are forced to expose real interfaces; Tier-B inversions remove upward deps on app-layer modules.
- **Feature-gated dev builds** let contributors compile a subset of the surface.

## Risks

- **Concurrent-tree hazard.** The working tree currently carries a large volume of uncommitted work from other sessions. Decomposition rewrites shared files (`Cargo.toml`, `lib.rs`, `.cargo/config.toml`), so it must be sequenced against that WIP — hence W1 (config-only) first and one-crate-per-commit thereafter. See `concurrent-tree-safety`.
- **Tauri command-in-crate caveat.** The macro-generated `__cmd__*` wrapper must be `pub` and imported at the `generate_handler!` site; miswiring fails at compile time (not silently), so it is self-checking.
- **Capability/ACL drift.** Commands moving crates must keep their `capabilities/*.json` entries valid — covered by the `tauri-rust-reviewer` trap list.
- **libgit2/onnxruntime build scripts** run per-crate; extraction must preserve the `build.rs` PDFium/dylib staging and the `ort` `copy-dylibs` behavior.

## Non-goals

- No runtime behavior change, no dependency upgrades beyond dedup, no change to `output: "export"` or the bundle layout.
- Not decomposing `companion_api` internally in this ADR (tracked separately); it stays app-side as the orchestrator.
- No move to `panic = "abort"` (the crash-handler/minidumper path relies on unwinding).

## Alternatives considered

- **Do nothing / only W1 toolchain wins.** Real but bounded (~30–50% on link/incremental); leaves the 170k-LOC recompile-everything problem intact. W1 is adopted *as well*, not *instead*.
- **Split by `mod` visibility / internal `#[path]` tricks.** Does not change the compilation unit — cargo still recompiles the whole crate. No compile-speed benefit.
- **One giant `cognia-backend` library crate + a razor-thin `src-tauri` bin.** Cheaper to do but only helps if the bin changes more than the lib; it does not give per-subsystem incremental isolation, which is the actual win.

## Appendix — measured data (2026-07-13)

- Per-module LOC and `#[tauri::command]` counts, cross-module import graph, and heavy-dep ownership were captured via `wc`/`grep` over `src-tauri/src/` and `Cargo.lock`. The coupling graph confirmed the leaf/hub split and the three cyclic clusters above.
- Reproduce: `cargo build --timings`, `cargo tree -d`, and the per-module `grep -c '#\[command\]'` / `grep -rhoE 'crate::[a-z_]+'` sweeps.

## Key files

- Workspace: root `Cargo.toml` (`[workspace] members`), `.cargo/config.toml`, `rust-toolchain.toml`, `src-tauri/Cargo.toml`, `src-tauri/build.rs`
- Assembly point (Tier C): `src-tauri/src/lib.rs` (`mod` decls + `.manage()` + `generate_handler!`)
- Extraction template target: `src-tauri/src/vector/` → `crates/cognia-vector/`
- Existing precedent: `crates/cognia-sandbox-runner/`, `crates/cognia-cli/`
