---
title: "ADR 0006: Plugin system completion"
description: "Wires the plugin runtime into Cognia-next's user-visible surfaces — settings, /plugins route, marketplace, composer, claude adapter, built-ins."
---

## Status

Accepted, 2026-05.

## Context

The repository already shipped a 75-file plugin runtime under `lib/plugin/`
(API surface, hook dispatcher, sandbox, permission guard, signature verifier,
rate limiter, lifecycle hooks). Database schema v15 added five plugin
tables (`plugins`, `pluginPermissions`, `pluginReviews`, `pluginAnalytics`,
`pluginScheduledJobs`). What was missing:

- No settings entry for plugins, no `/plugins` route, no UI components.
- SDK message pump (`hooks/chat/use-claude-chat.ts`) and request build site
  (`lib/claude/build-options.ts`) ignored the plugin lifecycle hook
  dispatcher.
- The chat composer didn't render plugin-contributed extension slots or
  surface plugin slash commands.
- Three of the six advertised built-in plugins were empty manifest shells
  with `runtime.browser.unsupported` diagnostics.
- The marketplace entry path went through `lib/skills/marketplace-install`
  for skills and `lib/plugin/package/marketplace` for plugins separately,
  meaning the unified storefront couldn't carry both kinds.

The task brief (`hi-lovely-clover.md`) called for a "complete, no
shortcuts" implementation that integrated cleanly with existing systems.

## Decisions

### 1. Marketplace consolidation — Option C

Plugins reuse the Skills marketplace as the user-facing storefront. We
discriminate by `MarketplaceItem.type: "skill" | "plugin"` and dispatch
inside `installMarketplaceItem` / `uninstallMarketplaceItem`:

```ts
if (item.type === "plugin") {
  const { getPluginMarketplace } = await import("@/lib/plugin/package/marketplace")
  await getPluginMarketplace().installPlugin(item.pluginId ?? item.sourceId, item.version)
  return { kind: "plugin", pluginId, installed: true }
}
// …skills path unchanged
```

The plugin marketplace runtime stays the source of truth for plugin
installs (dependency resolution, conflict detection, signature
verification). Skills marketplace just routes the request.

Rejected alternatives:

- **Option A — shared `lib/marketplace-shared`**: would require unifying
  type systems, hurt the "copy and adapt" preference users expressed.
- **Option B — keep both fully independent**: leaves users with two
  storefronts to discover the same content.

### 2. Permission UX — manifest grant + runtime dialog

Permissions declared in `manifest.permissions[]` are silently granted at
install time (`PluginManager.installPlugin` calls
`permissionGuard.registerPlugin`). `manifest.optionalPermissions[]` and
runtime-requested permissions go through `permission-requests.ts`
which prompts the user via a dialog. Dangerous permissions
(`shell:execute`, `process:spawn`, `python:execute`, `filesystem:write`)
are highlighted in red across the permission UI.

### 3. Configure tab — JSON-Schema-driven form

`/plugins` carries a `Configure` tab (per-plugin) that introspects
`manifest.configSchema` and renders a shadcn-driven form. Supports
`string`, `number`, `boolean`, `enum` (`string` + `enum`), `array<string>`.
Unsupported field shapes degrade to a raw JSON preview rather than
crashing. Persistence uses `setPluginConfig`; the manager picks up the
new value on next activation.

### 4. Built-in plugins

Six built-in plugins ship with cognia-next:

| Plugin                     | Status                  | Surface                                                                                                                  |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `cognia-clipboard-tools`   | existed                 | `clipboard_status`                                                                                                       |
| `cognia-workspace-tools`   | empty shell → full impl | `workspace_list_files` / `workspace_read_file` / `workspace_search` (browser fallback returns `desktop-only` diagnostic) |
| `cognia-web-tools`         | empty shell → full impl | `web_fetch` / `web_download` (browser falls back to `<a download>`, desktop writes through Tauri fs)                     |
| `cognia-screenshot`        | new                     | `take_screenshot` agent tool + `/screenshot` slash command                                                               |
| `cognia-prompt-templates`  | new                     | `/template`, `/template-add`, `/template-remove`, `/template-list` slash commands; persists templates in plugin storage  |
| `cognia-clipboard-history` | new                     | `clipboard_history_*` agent tools + `/clipboard-history` slash command; encrypted buffer via `setSecure`/`getSecure`     |

`browser-builtin-registry.ts` no longer carries
`runtime.browser.unsupported` diagnostics; every entry has a `load`
function that returns a `PluginDefinition`.

### 5. Plugin point contracts

- 30 `CANONICAL_EXTENSION_POINTS` (27 implemented + 3 deprecated aliases)
- 108 `CANONICAL_HOOK_POINTS`
- 10 `CANONICAL_ACTIVATION_PATTERNS`

The mapping from each contract to the host file that consumes it is
maintained in `lib/plugin/contracts/extension-point-consumers.md`. The
`auditPluginPointContracts()` function in `plugin-points.ts` produces a
verified / missing-proof report that the Plugins → Audit settings sub-tab
renders live.

Governance has two modes (`warn` / `block`), persisted in
`localStorage` under `cognia.plugins.policy`.

### 6. Composer integration

- Plugin slash commands flow through `lib/chat/slash-command-registry`'s
  `source: "plugin"` channel; `composer.tsx` adapts them to the legacy
  `SlashCommand` shape so the existing popover renders them alongside
  built-ins.
- `chat.input.above` and `chat.input.below` extension slots wrap the
  composer body. `chat.input.actions` injects up to 3 plugin toolbar
  items into the bottom toolbar.
- Plugin-thrown extensions stay isolated behind a per-extension
  `ErrorBoundary` so a crashing plugin can't take down the chat.

### 7. Claude SDK integration

`lib/claude/adapter-hooks.ts` wraps every `dispatchOn*` from the
lifecycle dispatcher with a `hasListeners()` short-circuit. Three
integration points fire today:

- `dispatchUserPromptSubmit` — fires before `sendPrompt`. Can block,
  modify, or proceed.
- `dispatchChatError` — fires on `session_ended` with error.
- `dispatchPostChatReceive` — fires when the assistant turn seals.

`lib/claude/build-options.ts` lazy-imports
`getPluginAgentBridge().getPluginTools()` and folds enabled plugin tools
into `SendOptions.allowedTools`.

### 8. Settings page — 8 sub-tabs

`components/settings/sections/plugins-section.tsx` mirrors the data
section's tabbed shell: Overview / Installed / Marketplace / Permissions
/ Scheduled / Devtools / Audit / Settings. URL state synced to
`?pluginsTab=`. Devtools sub-tab is gated behind `NODE_ENV === "development"`
or the `cognia.plugins.developerMode` localStorage flag.

### 9. /plugins route — full M5C surface

`app/plugins/page.tsx` mounts `<PluginPanel/>`. The panel composes 28
new components under `components/plugins/`:

- Panel shell: `plugin-panel`, `plugin-panel-context`, `plugin-panel-header`,
  `plugin-panel-tabs`, `plugin-panel-toolbar`, `plugin-panel-grid`
- Cards & detail: `plugin-card`, `plugin-detail`, `plugin-detail-panel`,
  `plugin-marketplace-card`, `plugin-marketplace-detail`,
  `plugin-signature-badge`
- Marketplace: `plugin-marketplace`, `plugin-discovery`,
  `plugin-category-sidebar`, `plugin-filter-sheet`
- Dialog hosts: `plugin-delete-dialog`, `plugin-import-dialog`,
  `plugin-conflict-dialog`, `plugin-update-dialog`,
  `plugin-rollback-dialog`, `plugin-permission-review`,
  `plugin-config-form`
- Specialised surfaces: `plugin-batch-actions-bar`,
  `plugin-scheduled-jobs`, `plugin-devtools-panel`,
  `plugin-dependency-graph`, `plugin-resource-manager`,
  `plugin-analytics`, `plugin-backup-panel`, `plugin-extension-slot`

Each component has a colocated `.test.tsx`. State-machine state lives in
`stores/plugins/plugins-store.ts`; live-data hooks live under
`hooks/plugins/`.

### 10. Internationalisation

`plugins.*` and `settings.plugins.*` namespaces added to both
`i18n/messages/en.json` and `i18n/messages/zh-CN.json` (~280 keys per
locale, mirroring the structure 1:1).

## Consequences

- The plugin runtime now has user-visible exits everywhere: settings
  shell, full panel, composer, chat error display.
- Skills and plugins co-exist in one storefront without surfacing two
  competing marketplaces to the user.
- Built-in plugins demonstrate the full API surface (agent tools, slash
  commands, secure storage, configSchema-driven config).
- Adding a new SDK lifecycle event surface in the future is mechanical
  — `adapter-hooks.ts` is the only file that needs to grow.

## Follow-up (2026-05)

A consistency closeout cleared five debts left after the original
implementation:

1. **Stub removal** — `lib/plugin/index.ts` no longer ships a fallback
   `pluginManager` or duplicate `validatePluginManifest`. The single
   canonical validator lives at `lib/plugin/core/validation.ts` and is
   re-exported from the package entry. `stores/plugin/plugin-store.ts`
   now passes the active `governanceMode`, closing a silent gap where
   runtime-synced manifests skipped contract validation.
2. **Silent-catch policy** — 12 `catch { /* ignore */ }` sites switched
   to `recordSilentFailure`, which writes to the diagnostics store
   only when the failure is unexpected (i.e. desktop-mode Tauri
   invoke failure rather than expected web-mode unavailability).
   `PluginPointDiagnostic` widened to accept a new `"runtime"`
   `pointKind` and a `"plugin.silent-failure"` code so silent-failure
   entries flow through the same store as governance diagnostics.
3. **Diagnostics panel** — Audit sub-tab grew a live "Plugin runtime
   diagnostics" panel powered by `subscribePluginPointDiagnostics`,
   with severity filtering and per-plugin clear actions.
4. **IPC byte-size correctness** — `messaging/ipc.ts` now measures
   real UTF-8 byte length instead of UTF-16 code units, fixing a
   silent oversize-passthrough bug for non-ASCII payloads.
5. **Doc drift** — hook point count corrected from 102 to 108,
   activation patterns from 11 to 10, matching `plugin-points.ts`.

The Tauri backend gap (31 `plugin_*` invoke calls without Rust
handlers) is intentionally deferred to ADR 0007. Until that lands,
desktop users will see silent-failure diagnostics for every
backend-bound operation — the noisy panel is the work-item registry
for the next cycle.

## References

- [`lib/plugin/contracts/plugin-points.ts`](https://github.com/.../plugin-points.ts)
- [`lib/plugin/contracts/extension-point-consumers.md`](https://github.com/.../extension-point-consumers.md)
- [`stores/plugins/plugins-store.ts`](https://github.com/.../plugins-store.ts)
- [`components/plugins/`](https://github.com/.../components/plugins/)
- Plan file: `~/.claude/plans/hi-lovely-clover.md`
