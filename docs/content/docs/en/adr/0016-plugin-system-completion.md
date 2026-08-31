---
title: "0016 — Plugin System Completion"
description: "Closes the desktop-runtime gap left by ADR 0006. Audits surface 82 plugin_* invoke commands without Rust handlers (not 31, as ADR 0006 estimated), 38 host call sites missing for already-authored hook dispatchers, and 8 silent catches that bypass the diagnostics store."
---

# ADR 0016 — Plugin System Completion

**Status:** Proposed
**Date:** 2026-05-09
**Supersedes follow-up:** ADR 0006 §"Tauri backend gap"

## Current state amendment (2026-08-13)

The Plugin Media TypeScript surface now has registered native handlers for concatenate, effect, transition, and export. They reuse `cognia-media`'s validated ffmpeg process boundary, timeouts, temporary-path handling, and error model; no second JavaScript media API was introduced. Demoted hook families remain deferred.

## Current state amendment (2026-08-31)

The P1-7 devtools track is retired. Its file watcher survives, everything built around it does
not.

`plugin_dev_server_start` and `plugin_dev_server_stop` were removed. They set an in-memory
`running = true` and returned: no port was bound and no server existed, while the renderer built
`getUrl()`, `getWebSocketUrl()` and `connectedClients` on top of them. `plugin_reload` went too,
because the `plugin-hot-reload:<id>` event it emitted had exactly one listener and that module is
gone. All three are out of `protocol/companion-commands.json`,
`protocol/headless-command-dispositions.json` and the generated `all-app-commands.toml`.

On the TypeScript side, `dev-server.ts`, `profiler.ts`, `console-tap.ts`, `dev-tools.ts`,
`dev-extension-controller.ts`, `managed-ide-dev-mode.ts`, `hot-reload.ts` and the barrel that made
them look referenced were deleted, along with the nine-tab `PluginDevtoolsPanel` that was their
only intended consumer and had no production mount. The `hot-reload.ts:372-376` silent-catch row
in the table below therefore names a file that no longer exists.

`plugin_watch_start` / `plugin_watch_stop` hold a real `notify` watcher and are kept. They are now
driven by `lib/plugin/devtools/file-watch.ts`, which reloads through the verified cli-bridge path
rather than by emitting an event and hoping.

---

## Context

ADR 0006 shipped the plugin runtime — 75 source files under `lib/plugin/`, five Dexie tables, full settings UI, marketplace consolidation, six built-in plugins, ten contract-driven decisions. The follow-up section (2026-05) acknowledged one remaining hole: "31 `plugin_*` invoke calls without Rust handlers, intentionally deferred to ADR 0007." ADR 0007 turned out to address theme rendering instead, so the gap stayed open — and grew, because the runtime kept adding `plugin_*` invoke sites without a corresponding handler track.

A fresh three-vector audit (2026-05-09) produced these numbers:

### A. Tauri backend gap is **2.6× larger** than ADR 0006 estimated

| Metric                                          | ADR 0006 follow-up #5 | Reality (this audit) | Source                                 |
| ----------------------------------------------- | --------------------- | -------------------- | -------------------------------------- |
| Distinct `plugin_*` invoke commands in TS       | 31                    | **82**               | grep `lib/plugin hooks/plugins stores` |
| `plugin_*` `#[tauri::command]` handlers in Rust | 0                     | **0**                | `src-tauri/src/lib.rs:211-386`         |

Verification commands:

```powershell
rtk grep -rEn "invoke[(<][^,]*['\"\`]plugin_[a-zA-Z_]+" lib/plugin hooks/plugins stores
rtk grep -n 'plugin_' src-tauri/src/lib.rs
```

The 51-command undercount in ADR 0006 was the result of partial sampling. Categories of newly discovered commands include filesystem watchers (`plugin_fs_watch/unwatch`), context-menu lifecycle (`plugin_context_menu_register/unregister`), shortcut registration (`plugin_shortcut_*`), window operations (`plugin_window_*`), media processing (`plugin_media_*`), devtools dev-server (`plugin_dev_server_*`), and the API bridge generic (`plugin_api_invoke`, `plugin_api_batch_invoke`).

Until any handler ships, every desktop-mode `invoke('plugin_*')` call rejects via `recordSilentFailure` and the user sees a no-op for installs, enables, permission grants, hot-reload, signature verification, etc.

### B. Hook dispatch coverage gap (38 of 108)

`lib/plugin/contracts/plugin-points.ts:167-276` declares 108 `CANONICAL_HOOK_POINTS`. The dispatcher classes in `lib/plugin/messaging/hooks-system.ts` (`PluginLifecycleHooks` lines 574-1067 and `PluginEventHooks` lines 1104-1821) **already implement every dispatch method**, including `dispatchThemeModeChange`, `dispatchProjectCreate`, `dispatchCanvasContentChange`, `dispatchWorkflowStart`, `dispatchExternalAgent*`, `dispatchMCP*`. What's missing is **host call sites**: theme stores never call `dispatchThemeModeChange`, canvas stores never call `dispatchCanvasContentChange`, and so on. The proof audit at `lib/plugin/contracts/runtime-proof-audit.ts` marks these as "verified" because the binding metadata exists; the runtime is silent in practice.

Categories with no host wiring today:

- Theme (3): `onThemeModeChange`, `onColorPresetChange`, `onCustomThemeActivate`
- Project / Knowledge (6): `onProjectCreate/Update/Delete/Switch`, `onKnowledgeFileAdd/Remove`
- Canvas (8): `onCanvasCreate/Update/Delete/Switch/ContentChange/VersionSave/VersionRestore/Selection`
- Artifact (2 partial): `onArtifactExecute`, `onArtifactExport`
- Export (3 + 2): `onExportStart/Complete/Transform`, `onProjectExportStart/Complete`
- RAG / Vector (3): `onDocumentsIndexed`, `onVectorSearch`, `onRAGContextRetrieved` (partial — only RAG path wired in `lib/plugin/bridge/workflow-integration.ts:145-159`)
- Workflow (4): `onWorkflowStart/StepComplete/Complete/Error`
- UI interaction (5): `onSidebarToggle`, `onPanelOpen/Close`, `onShortcut`, `onContextMenuShow`
- External Agent (7 partial): `onExternalAgent*` — partly wired in `hooks/agent/use-external-agent.ts`
- Code execution (3): `onCodeExecutionStart/Complete/Error`
- MCP (4): `onMCPServerConnect/Disconnect`, `onMCPToolCall/Result`

A subset will be demoted (see Decisions §3) because the host event source genuinely doesn't exist yet.

### C. Silent-catch leakage (8 sites)

ADR 0006 follow-up #2 migrated 12 `catch { /* ignore */ }` sites to `recordSilentFailure`, but later additions to `lib/plugin/core/context.ts` reintroduced bare or log-only catches. Sites verified by Read:

| File:line                                   | Pattern                                          | Site name                         |
| ------------------------------------------- | ------------------------------------------------ | --------------------------------- |
| `lib/plugin/core/context.ts:357-367`        | bare try/catch around `plugin_show_notification` | `ui.showNotification`             |
| `lib/plugin/core/context.ts:592-617`        | implicit catch at `plugin_python_import`         | `python.import`                   |
| `lib/plugin/core/context.ts:869-889`        | `.catch(loggers.manager.error)` × 2              | `fs.watch`, `fs.unwatch`          |
| `lib/plugin/core/context.ts:1024-1048`      | `.catch(loggers.sandbox.error)` × 2              | `shell.spawn`, `process.kill`     |
| `lib/plugin/core/context.ts:1124-1136`      | `.catch(...)` × 2                                | `shortcut.register/unregister`    |
| `lib/plugin/core/context.ts:1165-1180`      | `.catch(...)` × 2                                | `contextMenu.register/unregister` |
| `lib/plugin/api/media-api.ts:969-986`       | `.catch(error => …)` logs MediaAIError           | `media.imageAI`                   |
| `lib/plugin/devtools/hot-reload.ts:372-376` | `.catch(() => {})`                               | `hotReload.restoreState`          |

These sites swallow Tauri-mode failures invisibly, so the Plugins → Audit panel — which ADR 0006 designed as the live diagnostic surface — under-reports desktop-mode breakage.

### Out-of-scope (intentionally not addressed)

Two audit dimensions came back clean and require no work:

- **i18n**: 36 `plugins.*` + 12 `settings.plugins.*` keys, fully synchronized between `i18n/messages/en.json` and `i18n/messages/zh-CN.json`. All 28 `useTranslations()` call sites resolve in both locales. No drift, no dead keys (the two "container" keys `plugins.tabs` and `plugins.signature` are accessed via dynamic iteration, not stale).
- **API surface**: all 14 `lib/plugin/api/*-api.ts` modules are wired into `FullPluginContext` via `lib/plugin/core/context.ts:146-211`. `PluginContext` (base, 19 fields) and `FullPluginContext` (base + 14 extended APIs) align with the type declarations in `types/plugin/plugin.ts`.

## Decisions

### 1. Tier the work into 5 sequenceable batches (T0–T4)

| Tier   | Scope                                                                                                   | Files touched                                           | Risk                    |
| ------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------- |
| **T0** | This ADR + activation-pattern count fix in `extension-point-consumers.md`                               | 2 docs                                                  | none                    |
| **T1** | Silent-catch migration (8 sites) + 2 layout fixes (batch-actions-bar overflow, permission-review table) | TS + RTL tests + Playwright                             | low                     |
| **T2** | Wire 38 hook host call sites; demote what has no host event source                                      | host stores in `stores/<domain>/*` + `plugin-points.ts` | medium                  |
| **T3** | Implement Rust handlers in batches 3a/3g/3b/3c/3d (~64 commands, deferring Python and Media)            | `src-tauri/src/plugin_api/**` + `lib.rs`                | high (per-batch review) |
| **T4** | Documentation closure + CI gate to keep `expected: !isTauri()` flags honest                             | docs + `scripts/check-silent-failure-flags.ts`          | low                     |

Sequence rule: T1.1 (silent-catch migration) ships before any T3 batch. Migration is purely additive — every catch site that already swallowed an error continues to swallow it; we just _record_ it now. Once T1.1 lands, the Audit panel becomes the data-driven queue for T3 batch ordering.

### 2. Defer Python (Batch 3e, 13 commands) and Media (Batch 3f, 5 commands)

- **Python**: PyO3 is absent from `src-tauri/Cargo.toml` (verified all 156 lines). Adding it requires Python-headers in CI for Windows/macOS/Linux, GIL semantics decisions, and a sandboxing strategy. Defer to **ADR 0017 (Plugin Python Runtime)**. Until 0017, TS-side `python.call/eval/import` stays a no-op in desktop and `recordSilentFailure({ expected: true })` even when Tauri is present.
- **Media**: needs ffmpeg sidecar binary. Defer to **ADR 0018 (Plugin Media Pipeline)**. Existing `lib/plugin/api/media-api.ts:969-986` already throws `MediaAIError` cleanly, so deferring does not regress current tests.

### 3. Demote hooks with no host event source (don't silently drop)

For hook categories where the host event source genuinely doesn't exist yet (e.g. `onAgentPlanCreate` / `onAgentPlanStepComplete` already documented as "future planner hook" in `extension-point-consumers.md:115-116`), the contract entry moves from `CANONICAL_HOOK_POINTS` to a new `DEPRECATED_HOOK_POINTS` constant. `validatePluginManifest` emits a one-shot warning when a plugin registers a deprecated hook.

This is an "honest-up" step: the proof audit at `runtime-proof-audit.test.ts` should pass _because_ the hook is no longer canonical, not because the audit was loosened.

The full demoted-points table will be populated as T2 lands; categories currently expected to demote are documented inline in the plan but not finalized until each host store has been searched for an event source.

### 4. `expected: !isTauri()` flag is the contract that ties T1 to T3

`recordSilentFailure` (`lib/plugin/contracts/diagnostics-store.ts:79-98`) accepts `expected: boolean`. Convention:

- `expected: !isTauri()` — failure is structurally expected in web mode; debug-log only. Audit panel shows it under "expected".
- `expected: false` — desktop runtime failure; warn-log + write to `PluginPointDiagnostic` with code `"plugin.silent-failure"`. Audit panel shows it under "warning".

Every T1.1 site starts with `expected: !isTauri()`. As each T3 batch ships its matching Rust handler, the corresponding TS sites flip to `expected: false`. A CI gate (T4, `scripts/check-silent-failure-flags.ts`) fails the build if a TS file mentions `plugin_X` with `expected: !isTauri()` while `lib.rs` already lists `plugin_X` in `generate_handler!` — preventing the flag from getting stuck.

### 5. Anti-duplication canon (codified to prevent rebuilds)

| Concern                  | Canonical path                                                                 | Rule                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Manifest validator       | `lib/plugin/core/validation.ts:validatePluginManifest`                         | always call; never re-implement                                                            |
| Plugin manager singleton | `lib/plugin/core/manager.ts:getPluginManager`                                  | grep for `new PluginManager(` should return 0 results                                      |
| IPC byte-size            | `lib/plugin/messaging/ipc.ts`                                                  | `new TextEncoder().encode(x).byteLength`, not `.length`                                    |
| Hook dispatcher          | `lib/plugin/messaging/hooks-system.ts`                                         | one `HookDispatcher`; two dispatcher classes (`PluginLifecycleHooks` + `PluginEventHooks`) |
| Permission gate          | `lib/plugin/security/permission-guard.ts` + `lib/plugin/api/permission-api.ts` | route every check through `requestPluginPermission`                                        |
| Theme bridge             | `lib/plugin/api/theme-api.ts:createThemeAPI`                                   | manifest.themes auto-discovered on enable                                                  |
| Connector bridge         | `lib/plugin/bridge/connectors-bridge.ts:registerPluginAdapters`                | one call per plugin enable; cleans up on disable                                           |
| Slash-command channel    | `lib/slash-commands/registry.ts` with `source: "plugin"`                       | tagging by `pluginId` enables bulk-removal on disable                                      |
| Diagnostics store        | `lib/plugin/contracts/diagnostics-store.ts:recordSilentFailure`                | `expected: !isTauri()` until Rust handler ships, then flip to `false`                      |

### 6. Rust module convention: `src-tauri/src/plugin_api/` mirrors `companion_api/`

Tier 3 lands in `src-tauri/src/plugin_api/` with the same layout established by `src-tauri/src/companion_api/` and `scheduler/`:

```
src-tauri/src/plugin_api/
├── mod.rs              // module declarations + PluginRuntimeState struct
├── error.rs            // PluginError + Result alias (thiserror)
├── commands.rs         // re-exports for the generate_handler! macro
├── lifecycle.rs        // 3a — plugin_load/enable/disable/unload/install/uninstall/get_all/runtime_snapshot/set_state/get_state
├── permissions.rs      // 3a — plugin_permission_grant/list/revoke
├── api_bridge.rs       // 3g — plugin_api_invoke/batch_invoke
├── fs_watcher.rs       // 3b — plugin_fs_watch/unwatch
├── window_ops.rs       // 3b — plugin_window_*
├── shortcut_ops.rs     // 3b — plugin_shortcut_register/unregister
├── context_menu.rs     // 3b — plugin_context_menu_register/unregister
├── notification.rs     // 3b — plugin_show_notification
├── process_ops.rs      // 3b — plugin_process_kill
├── backup.rs           // 3c — plugin_backup_create/restore/delete
├── signature.rs        // 3c — plugin_verify_signature/create_signature/generate_keypair
├── marketplace.rs      // 3c — plugin_marketplace_versions/get_directory/download_version/invalidate_cache
├── devtools.rs         // 3d — plugin_dev_server_*/watch_*/reload/list_dev_plugins
└── tray_items.rs       // 3b (addendum, ADR 0016 P2-A, 2026-05-17) — plugin_tray_item_register/unregister/list/unregister_by_plugin
```

State is registered exactly once via `.manage(PluginRuntimeState::new(...))` in `lib.rs` before the `.invoke_handler(generate_handler!...)` call. Shared mutable state uses `Arc<RwLock<...>>` (parking_lot) and `Arc<DashMap<...>>` for plugin-keyed maps. `PluginError` derives `thiserror::Error` and serializes to its display string for `invoke()` rejection.

> **Addendum (2026-05-17, P2-A):** `tray_items.rs` shipped alongside the rest of Batch 3b but did not appear in the original module table above. It exposes four `#[tauri::command]` handlers (`plugin_tray_item_register`, `plugin_tray_item_unregister`, `plugin_tray_item_list`, `plugin_tray_item_unregister_by_plugin`) which back the tray-item slot plugins contribute through `manifest.trayItems`. Registered in `src-tauri/src/lib.rs:297-300`, ahead of the rest of `plugin_api::*` to match its placement in the tray subsystem. Classification: Batch 3b (Window/Shortcut/Context-menu/Notification family).

## Consequences

- **T1 lifts diagnostic blackouts**: every silent-catch site becomes visible in the Audit panel, providing a data-driven queue for T3 batch ordering.
- **T2 closes the contracts/runtime mismatch**: `runtime-proof-audit.test.ts` can be trusted again as a coverage gate.
- **T3 makes desktop mode functional**: install / enable / permission grant / hot-reload / signature verify all work. Until T3a lands, every desktop-mode plugin operation is a silent no-op.
- **T4 prevents regression**: the CI gate ensures shipping a Rust handler always flips the matching TS `expected:` flag, so the diagnostics panel stays honest.
- **Demoted hooks**: plugins that registered a since-demoted hook continue to load (no breaking change), but the manifest validator emits a one-time warning. No plugin ships in `plugins/` (built-in registry verified) that registers any of the candidate-demote hooks today.

## Demoted hook points (filled during T2 landing)

| Hook                                         | Reason for demotion                                                                                                                                                                                                                                                 | Host file searched                                                                               | Grep terms                                                      | Replacement / next step                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `onThemeModeChange`                          | T2 scope only permitted edits to `stores/theme/`; the actual `setTheme` action lives in `stores/settings/settings-store.ts`, which was out of scope. `stores/theme/` only contains `custom-theme-store.ts` (HTML-export theme tokens, unrelated to app theme mode). | `stores/theme/`, `stores/theme/custom-theme-store.ts`                                            | `setMode`, `setTheme`, `colorPreset`                            | Restore to canonical when a future ADR re-scopes T2 to include `stores/settings/` or migrates theme actions into `stores/theme/`.        |
| `onColorPresetChange`                        | Same demotion path as `onThemeModeChange` — `setColorTheme` lives in `stores/settings/settings-store.ts`, out of scope for T2.                                                                                                                                      | `stores/theme/`, `stores/theme/custom-theme-store.ts`                                            | `setColorTheme`, `colorPreset`                                  | Restore to canonical when `setColorTheme` is callable from a host file inside the T2 permitted set.                                      |
| `onCustomThemeActivate`                      | The `stores/theme/custom-theme-store.ts` `upsert`/`remove`/`clone` actions are for the HTML-export theme catalog, not the app's active custom theme. The actual `setActiveCustomTheme` action lives in `stores/settings/settings-store.ts`, out of scope for T2.    | `stores/theme/custom-theme-store.ts`, `stores/settings/settings-store.ts` (read-only inspection) | `activate`, `setActiveCustomTheme`, `activeCustomThemeId`       | Restore to canonical when the active-custom-theme action is exposed from a host file inside the T2 permitted set.                        |
| `onAgentPlanCreate` (P1-5, 2026-05-17)       | No host event source. `extension-point-consumers.md:115` already flagged this as a "future planner hook (currently unused)" pre-demotion — the agent planner that would call this dispatcher was never implemented.                                                 | `lib hooks stores app components` workspace-wide                                                 | `dispatchOnAgentPlanCreate`, `agentPlan`, `planCreate`          | Restore to canonical when an agent planner ships that fires this dispatcher; track via a future ADR scoped to the agent runtime.         |
| `onAgentPlanStepComplete` (P1-5, 2026-05-17) | No host event source. Same root cause as `onAgentPlanCreate`.                                                                                                                                                                                                       | `lib hooks stores app components` workspace-wide                                                 | `dispatchOnAgentPlanStepComplete`, `planStep`, `stepComplete`   | Restore alongside `onAgentPlanCreate` when the agent planner lands.                                                                      |
| `onArtifactExecute` (P1-5, 2026-05-17)       | No host event source. `extension-point-consumers.md:205` claimed an "artifact runner" as the consumer; no such runner exists in the codebase. `dispatchArtifactExecute` in `hooks-system.ts:1649` is a dispatcher with zero callers.                                | `lib hooks stores app components` workspace-wide                                                 | `dispatchArtifactExecute`, `artifactRunner`, `artifact.execute` | Restore when an artifact-runner subsystem ships and starts firing the dispatcher.                                                        |
| `onArtifactExport` (P1-5, 2026-05-17)        | No host event source. `extension-point-consumers.md:206` claimed an "export pipeline" as the consumer; the existing export pipeline (`dispatchExportStart/Complete/Transform` via `lib/plugin/api/export-api.ts`) is artifact-agnostic.                             | `lib hooks stores app components` workspace-wide                                                 | `dispatchArtifactExport`, `exportArtifact`, `artifact.export`   | Restore when an artifact-specific export pipeline ships that fires this dispatcher (separate from the existing project-export pipeline). |

Each row added during T2 must reference the host file that was searched, the search terms, and an expected ADR for restoring canonical status if the host event source materializes later.

## Verification

After each tier:

```powershell
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm test --coverage              # ≥90% per CLAUDE.md
rtk pnpm build                        # Next.js export still works
```

After T2:

```powershell
rtk pnpm test lib/plugin/contracts/runtime-proof-audit.test.ts
```

After every T3 batch:

```powershell
rtk cargo test --lib --package app_lib --manifest-path src-tauri/Cargo.toml
rtk cargo test --tests --package app_lib --manifest-path src-tauri/Cargo.toml
rtk cargo clippy --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings
rtk pnpm tauri build --debug
```

UI changes (T1.2/T1.3):

```powershell
rtk pnpm playwright test tests/e2e/plugins
# Plus 375 / 768 / 1440 visual snapshots via mcp__playwright
```

## Follow-ups

- **ADR 0017** — Plugin Python Runtime (PyO3, sandboxing, CI matrix).
- **ADR 0018** — Plugin Media Pipeline (ffmpeg sidecar, video effects, transitions).
- **ADR 0006 §Follow-up #6** — backlink to this ADR with shipped-batch dates.

## References

- ADR 0006 (`docs/content/docs/adr/0006-plugin-system.md`) — original plugin system design.
- `lib/plugin/contracts/plugin-points.ts` — canonical contract registry.
- `lib/plugin/contracts/extension-point-consumers.md` — contract-to-host mapping (truthing target for T2/T4).
- `lib/plugin/contracts/runtime-proof-audit.ts` — `auditPluginPointContracts()` produces the verified / missing-proof report rendered by the Audit sub-tab.
- Plan file: `~/.claude/plans/agile-puzzling-cerf.md`.
