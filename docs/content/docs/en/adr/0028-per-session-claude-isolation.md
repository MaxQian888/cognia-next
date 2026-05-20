---
title: ADR-0028 — Per-session Claude Code isolation
description: Per-`ChatSession` OAuth / `CLAUDE_CONFIG_DIR` / base-URL / proxy isolation via per-`query()` env, WarmQuery pool keyed by config tuple, and a five-tier hybrid execution sandbox (vendored Codex Windows sandbox + sandbox-exec + bwrap, plus Node 24 `--permission`, Wasmtime, e2b microVM, and a per-action policy gate for `computer_use`).
---

# ADR-0028 — Per-session Claude Code isolation

**Status**: Proposed (2026-05-20)
**Supersedes**: extends ADR-0010 (Claude subscription OAuth), ADR-0020 (Computer-use completeness), ADR-0025 (Unified subscription module), ADR-0026 (Plugin extension point expansion)
**Authors**: Max Qian + Claude Opus 4.7

## Context

cognia-next's Node sidecar (`sidecar/claude-host.mjs`) is a single OS process that hosts N concurrent `@anthropic-ai/claude-agent-sdk` `query()` calls keyed by `sessionId`. `lib/claude/build-options.ts:resolveSendOptions` already isolates a large surface per `ChatSession`: `cwd`, `model`, `provider`, `providerCredentials`, `allowedTools` / `disallowedTools`, `mcpServers`, `additionalDirectories`, `permissionMode`, `settingSources`, `agents`, `appendHeaders`, per-call `env` (for `DEBUG` and `anthropic-beta` headers).

Four axes remain **frozen at sidecar boot**, however, and cannot vary mid-stream today:

1. `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` — one OAuth identity per sidecar process (`src-tauri/src/claude/sidecar.rs:143-155`).
2. `CLAUDE_CONFIG_DIR` / on-disk `~/.claude/` — one config directory per process (read once by the spawned CLI binary).
3. `ANTHROPIC_BASE_URL` — one endpoint per process.
4. `HTTPS_PROXY` / `HTTP_PROXY` — set by `proxy_config::current()` at sidecar spawn.

There is also **no OS-level execution sandbox** for high-risk tool calls (`Bash` / `Edit` / `Write` / native `text_editor`). `additionalDirectories` is an SDK-level gate, not an OS one. The existing 3-tier permission gate (`src-tauri/src/automation/permission.rs`), HITL consent broker (`src-tauri/src/automation/consent.rs`), and audit log (`src-tauri/src/automation/audit.rs`) provide policy-layer defence; execution-layer defence is missing.

ADR-0025 already shipped multi-account vaults (`src-tauri/src/subscription/vault.rs` with `ProviderVault::accounts[]`); only one account is "active" at a time today. Users have repeatedly requested per-session account switching (personal Pro + company Max). The recently-published `codex-rs/codex-windows-sandbox` crate (Apache-2.0, May 2026) and the documented `@anthropic-ai/sandbox-runtime` package (mac/Linux) make a credible cross-platform sandbox finally tractable.

A research pass also confirmed two SDK-level facts that reshape the architecture:

- **Each `query()` already spawns a fresh `claude-code` CLI subprocess.** The Node host is just an orchestrator. Per-call `options.env` (with explicit `{ ...process.env, ...override }` spread, since v0.2.113 `env` is replace-not-overlay) fully isolates the subprocess's environment. **No sub-sidecar process pool is needed** to vary OAuth / config-dir / base-URL / proxy per session.
- **Two concurrent CLI subprocesses sharing one `~/.claude/.credentials.json` will race on OAuth refresh** (open Anthropic issues #43392, #24317, #56339). Per-account `CLAUDE_CONFIG_DIR` directories eliminate the race by giving each account its own credentials file.

## Decisions

### Per-query env injection (Approach B)

`ChatSession` gains an optional `accountId` (UUIDv7 referring to `ProviderVault::accounts[]`); `Character` gains `accountIdOverride`; `AppSettings` gains `defaultAccountId`. `resolveSendOptions` walks `session → character → settings → ActiveAccountState` (today's active pointer remains the final fallback).

`src-tauri/src/subscription/active.rs` gains a **read-only** `env_for_account(provider, account_id) → Vec<(String,String)>` path that does not touch the active pointer. It emits an OAuth-mode-appropriate env (`CLAUDE_CODE_OAUTH_TOKEN` xor `ANTHROPIC_API_KEY`), plus `CLAUDE_CONFIG_DIR = <app_data>/cognia/claude-configs/<accountId>/` (ensure-created on first call), plus `ANTHROPIC_BASE_URL` from the account record, plus per-session proxy from `proxy_config::current()`.

`lib/claude/build-options.ts` resolves this tuple via two new Tauri commands (`claude_env_for_account`, `claude_proxy_env_for_session`) and merges into `opts.env` ahead of the `debugMode` branch. `sidecar/dispatch/anthropic.mjs:117` already does `baseEnv = { ...process.env, ...(sendOptions.env ?? {}) }` correctly — the comment is hardened to warn future readers about v0.2.113 replace semantics.

Sub-sidecar pools were considered and rejected: SDK-level subprocess-per-`query()` already gives every session an isolated CLI process. Running our own Node sub-sidecars on top is redundant and triples per-session memory cost.

### WarmQuery pool keyed by config tuple

The SDK's documented `startup()` API returns a `WarmQuery` that pre-warms a CLI subprocess and avoids the ~12 s cold start on each subsequent `.query()` call. We pool these in the host sidecar at `sidecar/warm-pool.mjs` keyed by `sha1(${accountId}|${configDir}|${baseURL}|${proxyURL}).slice(0,16)`.

Pool shape: `Map<tupleKey, { free: WarmQuery[], inUse: Set<WarmQuery>, total: number, lastUsedAt: number }>` with per-tuple cap 4, global cap 16, idle TTL 5 min, sweeper interval 60 s, startup timeout 30 s. Sessions hold one WarmQuery for their lifetime; on `session_ended` the instance returns to the tuple's `free` list. Pool exhaustion / startup timeout / crash falls back to non-pooled `query()` (12 s cold-start path) — never blocks the user.

The exact shape of `startup()`'s baked-vs-per-call options is verified via context7 before Phase 4 implementation. If `startup()` bakes options beyond `env`, the pool is dropped (Approach A) and the rest of the design ships unchanged.

### Five-tier hybrid execution sandbox

T1–T5 cover orthogonal threat surfaces; not all sessions touch all tiers.

#### T1 — OS-native sandbox for `Bash` / `Edit` / `Write` / `text_editor`

A new Rust trait `SandboxedExec` in `src-tauri/src/sandbox/mod.rs` exposes `run(SandboxCommand, SandboxPolicy)`. Per-platform `cfg(target_os = …)` backends:

- **Windows**: vendor a renamed subset of `codex-rs/codex-windows-sandbox` (Apache-2.0). Synthetic users `CogniaSandboxOffline` / `CogniaSandboxOnline`. Two shipped binaries: `cognia-sandbox-setup.exe` (UAC-elevated, idempotent, creates users + ACLs + Firewall rules) and `cognia-sandbox-runner.exe` (non-elevated, spawns target as sandbox user). WiX/NSIS installer hook calls `--uninstall` on app removal. OpenAI explicitly evaluated and rejected AppContainer for open-ended dev workloads (shells, git, package managers); restricted-token + ACL + per-SID Firewall is the de-facto 2026 Windows pattern.
- **macOS**: direct Rust call to `sandbox-exec -f <profile.sb> -- <argv>` with SBPL templates in `src-tauri/src/sandbox/macos/profiles/`. Plan B documented for the day Apple removes `sandbox-exec` — migrate to App Sandbox + XPC service.
- **Linux**: bundled static `bwrap` binary in Tauri resources; `--unshare-all` + optional `--share-net` + read/write binds + `--die-with-parent` + seccomp profile modeled on Flatpak.

T1 interception path: a new in-tree plugin `plugins/cognia-sandboxed-tools/` registers four MCP tools (`sandbox_bash` / `sandbox_edit` / `sandbox_write` / `sandbox_text_editor`). When sandbox is enabled for a session, `resolveSendOptions` adds the SDK builtins to `disallowedTools`, filters native `text_editor` out of the `anthropicTools` projection, appends a short system-prompt note, and surfaces the four sandboxed equivalents via `opts.pluginTools`. The existing `plugin_tool_exec` IPC bridge (`sidecar/builtin-tools/plugin-tools.mjs`) carries the call to the renderer, which dispatches to the `sandbox_exec` Tauri command. The SDK is untouched.

The alternative considered — wrapping the whole CLI subprocess via the SDK's `executable` hook — was rejected: it forces every tool through the sandbox (overkill for read-only ones), breaks MCP stdio IPC, and prevents per-tool policy. Per-`canUseTool`-style interception preserves the SDK's auth / env / MCP wiring and lets us apply tighter policy to Bash than to Edit.

#### T2 — Node 24 `--permission` for plugin JS executors

A new `lib/plugin/launcher/launchPluginJs.ts` re-execs each plugin JS entry as `node --permission --allow-fs-read=<…> --allow-fs-write=<…> --allow-net=<…> --allow-child-process=<…>` derived from the plugin's manifest `PluginPermission[]`. Permissions do not propagate into native children, so this layer composes with T1: a plugin that spawns `bash` still hits T1 interception via SDK builtins / our `sandbox_bash`.

#### T3 — Wasmtime + WASI for plugin WASM

A new `lib/plugin/wasm-runtime.ts` runs WASM plugins via `@bytecodealliance/jco` (or the `wasmtime` Node binding); host imports are limited to the preopens already managed by `lib/plugin/security/wasm-grant.ts`. The existing `wasm-grant` ledger is reused as-is.

#### T4 — e2b Firecracker microVM as opt-in tier

`Character.computerUseSettings.sandboxTier?: "os" | "microvm"`. When `microvm`, the `sandbox_*` tool implementations route to the existing `plugins/e2b-sandbox/` workspace backend instead of T1. No changes to e2b; only a routing branch.

#### T5 — Per-action policy gate for `computer_use`

`computer_use` cannot be process-sandboxed (the whole point is to drive the host UI). A new `src-tauri/src/automation/policy.rs` adds a fifth layer of defence on top of the existing four (3-tier permission, HITL consent, audit log, `Character.computerUseSettings.allowedToolIds`): per-action policy keyed by `target_app_name?`, `target_window_title_regex?`, `target_url_regex?`, `forbidden_screen_regions?`. Evaluated immediately after `permission.rs:PerCall` consent.

### Strict mode (no bypass)

When T1 backends are unavailable (Windows UAC denied, `bwrap` missing, runner exit nonzero), tool calls **deny strictly**. There is no Settings toggle to disable the sandbox and no `COGNIA_SANDBOX_BYPASS` env back door. Settings → Sandbox surfaces a red "Setup required" badge and a "Retry setup" button. The choice is deliberate: a bypass option creates a social-engineering target ("the assistant told me to turn off the sandbox") that no audit trail can offset.

### Resume bug (#16103) mitigation

The SDK's `--resume` ignores `CLAUDE_CONFIG_DIR` (only looks under default `~/.claude/projects/`). When `session.accountId` is set AND the sidecar has restarted (no `sdk_session_id` event since the last `sidecar_exited`), `resolveSendOptions` skips `opts.resumeSessionId` and prepends a Dexie-sourced replay prefix built by a new `lib/claude/replay.ts:buildReplayPrompt(messages, currentMessage, budget)`. Default-account sessions (no `accountId`) keep today's resume behaviour exactly.

### OAuth refresh write-back

Per-account `CLAUDE_CONFIG_DIR` directories eliminate the cross-process race on `.credentials.json`, but the CLI's in-subprocess refresh writes to disk, not back to our keyring vault. A new `src-tauri/src/subscription/anthropic/credential.rs::watch_configdir_credentials(account_id, path)` uses the `notify` crate to watch `<configdir>/.credentials.json`; on `mtime` change it parses the file and writes the rotated `refresh_token` back to the vault account record. Watcher lifecycle: start on first session for that account; stop when last closes.

### Audit + observability

`automation/audit.rs` gains a `Surface::Sandbox` variant. Every sandbox call (Allow / Deny / Error) is recorded; WarmQuery pool events (`warm_died`, `pool_exhausted`, `startup_timeout`) and `resume_replayed` events are recorded too. The existing 5000-cap VecDeque + Dexie `automationAuditLog` mirror carry them. The existing Diagnostics tab (`components/settings/sections/diagnostics-section.tsx`, observability group) is extended with collapsible cards for WarmQuery pool stats, sandbox event log, and sidecar restart counter — no new tab.

### UI surfaces

- **Settings → Sandbox** (new tab): health card with backend + version + synthetic user name (Windows), "Retry setup" / "Run health probe" buttons, default tier picker (OS / microVM — no "Off" per strict mode), per-tool network policy editor, T5 per-app policy editor.
- **Settings → Subscription** (extension): per-account "in use by X character / Y session" chips, "Set as default" action, delete confirmation listing references.
- **Settings → Diagnostics** (extension): WarmQuery / sandbox / sidecar collapsibles.
- **Character editor** (extension): account picker + `sandboxTier` override.
- **Chat session header**: account badge (hidden when user has one account) + switcher → toast "下一条消息将使用账号 X".
- **Composer**: shield indicator (filled / dashed / crossed for green / yellow / red) — colour paired with shape for colour-blind safety.
- **First-run wizard**: platform detect → UAC request → health check.

All new strings land in both `i18n/messages/en.json` and `i18n/messages/zh-CN.json` (≈120–150 keys). `pnpm lint:i18n:baseline` is run after the intentional change.

## Non-goals

- **Sub-sidecar pool / OS-process-per-tuple.** Validated as redundant given SDK subprocess-per-`query()`.
- **Per-tool-call sandbox boot.** One persistent sandbox per session via WarmQuery, mirroring the Vercel Managed Agents lifecycle.
- **macOS App Sandbox + XPC migration.** Plan B for when Apple sets a `sandbox-exec` removal date; deferred.
- **Mobile / Capacitor coverage.** Claude Code does not run on mobile; the thin client (ADR-0014, ADR-0015) is out of scope. The V2 headless server is the natural home for multi-tenant per-session isolation at the server layer.
- **Vercel Sandbox.** Cloud-only; not viable as a desktop-app default.
- **AppContainer / Hyperlight / `firejail` / `nsjail`.** Evaluated and rejected (AppContainer wrong shape per OpenAI, Hyperlight can't run shells, the last two are redundant vs `bwrap`).
- **Removing the existing single-account active pointer.** It remains the final fallback in the `accountId` resolution chain, so existing installs keep today's behaviour exactly.

## Consequences

- **Multi-account chat** becomes a per-session decision rather than a global mode switch.
- **OAuth refresh races** disappear for installs with ≥2 accounts (each gets its own `.credentials.json`).
- **Per-`query()` env** plumbing means each turn pays one Tauri IPC round-trip for env resolution (~1 ms).
- **WarmQuery pool** removes the ~12 s SDK cold start for warm tuples; cold tuples still pay it on first send.
- **Windows install** adds a one-time UAC prompt the first time the user opens a sandbox-using session. Two synthetic OS users (`CogniaSandboxOffline` / `CogniaSandboxOnline`) appear in Local Users; Firewall rules tie outbound network to a specific SID. Uninstall removes both.
- **Bundle size**: bundled `bwrap` adds ~1.5 MB to the Linux build; macOS uses the OS-provided `sandbox-exec`; Windows ships two ~500 KB exes.
- **Strict mode** means a Windows user who denies UAC on first sandbox use cannot send Bash / Edit / Write tool calls until they re-run setup. This is by design.
- **Resume cold-recovery** is degraded for per-account sessions (replays from Dexie instead of SDK resume) — slightly higher input-token cost on the first turn after sidecar restart, no functional gap.
- **Vendoring `codex-windows-sandbox`** commits us to manually backporting upstream security fixes. Review cadence: quarterly, tracked in `docs/superpowers/specs/`.
- **Backwards compatible**: `accountId` is optional; sessions / characters / settings without it behave exactly as today.

## Verification

| Suite                                             | Command                                 | Where                                                       |
| ------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Frontend Jest                                     | `pnpm test:coverage`                    | ubuntu-latest                                               |
| Sidecar `node --test`                             | `pnpm sidecar:test`                     | ubuntu-latest                                               |
| Rust unit (sandbox + active + watcher)            | `cargo test`                            | ubuntu / macos / windows                                    |
| Rust integration (real `bwrap` / `sandbox-exec`)  | `cargo test --test sandbox_integration` | ubuntu-latest + macos-14 (Windows runner-exe skipped — UAC) |
| Lint + i18n parity                                | `pnpm lint && pnpm lint:i18n`           | ubuntu-latest                                               |
| E2E Playwright (multi-account + sandbox dispatch) | `pnpm test:e2e` with MockSDK            | ubuntu-latest                                               |
| Plugin slots audit                                | `pnpm audit:slots`                      | ubuntu-latest                                               |

Coverage threshold ≥ 90 % per CLAUDE.md, enforced by existing Jest config + `cargo-tarpaulin` for new Rust modules.

Manual acceptance (per-release): see implementation plan at `~/.claude/plans/plan-distributed-wren.md` — full Windows install / UAC-deny / multi-account `mitmproxy` / WarmQuery hit-rate / OAuth race / resume-replay checklist.

## Open follow-ups

1. macOS `sandbox-exec` deprecation timeline — when Apple sets a date, schedule App Sandbox + XPC migration (current SBPL profiles port one-to-one to App Sandbox temporary-exception entitlements).
2. Quarterly review of upstream `codex-rs/codex-windows-sandbox` for security fixes worth backporting.
3. `startup()` API surface verification (Phase 4 implementation): if `startup()` bakes options beyond `env`, drop the WarmQuery pool (Approach A) — same plan minus pool.
4. Anthropic `--resume` ignoring `CLAUDE_CONFIG_DIR` (#16103) — track upstream fix; once landed, the Dexie replay path can be retired for per-account sessions.
5. V2 headless server multi-tenant per-session isolation (ADR-0014 follow-up) — port the trait / env-injection layer once the headless API is stable.
6. T2 / T3 / T4 / T5 telemetry — once the five tiers ship, measure tier-mix in the Diagnostics audit log to see whether T4 (e2b) opt-in rate justifies its bundle cost.
