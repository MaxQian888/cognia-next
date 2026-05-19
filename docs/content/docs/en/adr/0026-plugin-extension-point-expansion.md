---
title: "0026 — Plugin Extension-Point Expansion (v2)"
description: "Adds 6 new flat manifest fields, 8 new runtime points, 1 new hook (onBuildOptions), an around-style chat-middleware surface with a 3-strike circuit breaker, a global plugin modal stack, CSS-variable theme variants, a platform-capability namespace, and revives 2 deprecated UI slots. Additive only; legacy imperative APIs become @deprecated shims."
---

# ADR 0026 — Plugin Extension-Point Expansion

**Status:** Accepted
**Date:** 2026-05-19
**Branch:** `feat/plugin-extension-points-v2`

---

## Context

`cognia-next` ships a mature plugin platform — 23 capabilities, 25 permissions, 5 plugin types, 27 canonical UI slots, ~80 hook points, a per-plugin Dexie namespace, a message bus, a scheduler executor, an OCR provider registry, workflow node + trigger registries, and 16 first-party plugins. A three-agent audit against the in-tree plugins found **17 real gaps**: extension points that exist _implicitly_ (a host registry is wired but no plugin-facing API exposes it) or that plugins routinely **bypass** with direct `lib/*` imports and singleton setters. The most-bypassed bypasses were:

- `github-delivery` imports `registerNodeExecutor` directly + calls `setGithubRuntime` / `setIssueLoopDriver` / `setE2BBackend` as side-effects.
- `ocr` plugin assumes the host called `installOcrRuntime()` before activation; no `ctx.ocr` API exists.
- `e2b-sandbox` calls `setE2BBackend()` to wire its workspace backend.
- `computer-use` and `workflow-ai` call `registerPluginI18n()` imperatively when `manifest.i18n` already exists.
- 3 plugins call `isTauri()` directly because there's no `ctx.capabilities`.
- No plugin can wrap the chat send pipeline (`lib/claude/build-options.ts`), register custom message-part renderers, register custom modals, inject CSS variables, or register an OCR provider / workspace backend / AI helper.

This ADR closes those gaps with **additive** changes that leave existing imperative APIs working as `@deprecated` shims. Old in-tree plugins keep compiling; new plugins use the new declarative paths.

---

## Decisions

1. **Scope — all 17 gaps**, phased delivery (1 → 5).
2. **Breakage tolerance — additive only**. Legacy imperative APIs become `@deprecated` shims that delegate to the new path.
3. **Permission model — reuse the existing 25 `PluginPermission` values**; new contracts map to existing keys via `RUNTIME_POINT_PERMISSIONS` (`lib/plugin/contracts/plugin-points.ts`).
4. **Docs — new ADR (this file) + plugin-dev pages**. Do not touch other ADRs.
5. **Phase order** — contracts → providers → UI → chat middleware → unimplemented slots + capabilities.
6. **Manifest shape — flat root fields**, matching the existing `themes / connectors / mcpServerPresets / lspServers / skills / dexie / workflows / i18n` style.
7. **Chat interception — around middleware** with `(req, next) => Promise<Response>`; full control over build-options + assistant turn.
8. **Provider loading — lazy factory.** Manifest declares `entry` (path) + `export` (function name); host dynamic-imports only when the registry asks for the provider.
9. **AI provider scope — plugin-internal only.** The main chat loop stays inside Claude Code SDK. Split into `provider.ai-llm` + `provider.ai-embedding`.
10. **Middleware safety net — per-middleware timeout** (5s default, 60s max), error isolation (one throw skips that middleware), 3-consecutive-failure circuit breaker that disables the plugin and notifies the user.
11. **Message-renderer granularity — message-part only.** Host owns message chrome.
12. **Scheduler — reuse existing infra**; expose `ctx.scheduler.cron / .interval / .cancel`.

---

## What landed

### Phase 1 · Contracts (`types/plugin/*`, `lib/plugin/contracts/plugin-points.ts`, `lib/plugin/core/validation.ts`)

Six new flat manifest fields with the lazy-factory shape `{ id, label, entry, export, ... }`:

| Field               | Drives                                      | Permission      |
| ------------------- | ------------------------------------------- | --------------- |
| `ocrProviders`      | `provider.ocr`                              | `network:fetch` |
| `workspaceBackends` | `provider.workspace-backend`                | `process:spawn` |
| `messageRenderers`  | `provider.message-renderer`                 | `extension:ui`  |
| `aiProviders`       | `provider.ai-llm` / `provider.ai-embedding` | `network:fetch` |
| `modalMounts`       | `modal.mount`                               | `extension:ui`  |
| `chatMiddlewares`   | `chat.middleware`                           | `agent:control` |

Plus `configComponent?: { entry, export }` for per-plugin custom settings UI.

Eight new runtime points added to `CANONICAL_RUNTIME_POINTS`, each with a `binding` field pointing at the registry singleton that owns the contributions. One new hook (`onBuildOptions`) for plugins that only need to transform `SendOptions` without short-circuiting the chain.

Validation enforces the shared shape rules (`{ id, label, entry, export }`) plus field-specific extras (e.g. `aiProviders.kind` discriminant, `messageRenderers.partType` non-reserved, `chatMiddlewares.priority` in `[-100, 100]`, `chatMiddlewares.timeoutMs` in `(0, 60_000]`). Path-traversal guards mirror `themes-bridge`.

### Phase 2 · Provider registries

`ctx.ocr` (`lib/plugin/api/ocr-api.ts`) and `ctx.workspace` (`lib/plugin/api/workspace-api.ts`) join the plugin context. The workspace registry (`lib/github/workspace-backend-registry.ts`) generalizes the legacy `_e2bBackend` singleton — `setE2BBackend` becomes a `@deprecated` shim that registers under id `"e2b"`. Four new manifest-driven bridges land:

- `lib/plugin/bridge/ocr-providers-bridge.ts`
- `lib/plugin/bridge/workspace-backend-bridge.ts`
- `lib/plugin/bridge/message-renderer-bridge.ts`
- `lib/plugin/bridge/ai-providers-bridge.ts`

The AI-provider bridge adapts the new `PluginLlmProvider` / `PluginEmbeddingProvider` shape to the existing host `AIProviderDefinition` shape (`createAIProviderAPI`), so the existing settings-UI projection keeps working.

### Phase 3 · UI surface

- **Modal stack** — `stores/plugin/plugin-modal-store.ts` (Zustand LIFO), `lib/plugin/api/modal-api.ts` (`ctx.modal.openModal()`), `components/plugins/plugin-modal-root.tsx` mounted once in `app/layout.tsx`. Per-modal error boundary mirrors `<PluginExtensionSlot>`.
- **Per-plugin settings UI** — `manifest.configComponent` + `lib/plugin/bridge/config-component-bridge.ts` (lazy load + per-pluginId cache).
- **Composer dropdown groups** — `chat.input.menu` canonical extension point; mount in `components/chat/composer/bottom-toolbar.tsx` next to the existing `chat.input.actions` slot.
- **Theme CSS variables** — third `PluginThemeContribution` union variant `{ cssVariables: Record<string, string> }`; `themes-bridge` sanitizes names to `^--[a-z][a-z0-9-]*$`, values to ≤200 chars, rejects `</style>`.

### Phase 4 · Chat middleware + onBuildOptions

`lib/claude/chat-middleware/registry.ts` (registry with 3-strike breaker + listener events) and `lib/claude/chat-middleware/runner.ts` (Koa-style chain runner with `Promise.race`-driven timeout + try/catch isolation) compose into `ctx.chat.use(middleware, { id?, priority?, timeoutMs? })`. Plugin manifest entries (`chatMiddlewares[]`) flow through the bridge layer in subsequent migrations; the imperative path is the v1 surface.

`PluginEventHooks.dispatchBuildOptions(options)` (in `lib/plugin/messaging/hooks-system.ts`) runs the `onBuildOptions` transform pipeline — each plugin returns a `Partial<BuildOptionsHookInput>`; the dispatcher applies a shallow per-field merge in priority order. Plugins that need short-circuit control flow use `chat.middleware`; plugins that only tweak the options dict use `onBuildOptions`.

### Phase 5 · Capabilities + revived slots + i18n

- `ctx.capabilities` (`lib/plugin/api/capabilities-api.ts`) — read-only `{ tauri, mobile, web, browser, platform }` computed once at context creation.
- `chat.message.actions` revived — hover-action bar mounted in `components/chat/message-renderer.tsx`, distinct from the `chat.message.footer` host actions row.
- `settings.ai` revived — mounted at the top of `components/settings/api-key-section.tsx` so plugins that ship unified AI-settings cards have a single, stable host.
- `manifest.i18n` auto-wire was already in `lib/plugin/core/manager.ts:1057-1071`; documented here for completeness.

### Slots that **stay deprecated**

- `sidebar.right.top` / `sidebar.right.bottom` — no right rail surface exists in the host today; reviving them requires inventing a surface this ADR doesn't propose.
- `panel.header` / `panel.footer` — no generic panel-shell wrapper exists; reviving requires inventing one.

---

## Plugin permission gating

Plugin permissions are unchanged. New runtime points reuse existing permission keys via `RUNTIME_POINT_PERMISSIONS` in `lib/plugin/contracts/plugin-points.ts`. No new permission strings are introduced — when a plugin declares one of the new manifest blocks it implicitly requires the same permission set the bridge's runtime check would have asked for.

---

## Migration path for first-party plugins

These plugins keep working via legacy shims today but should migrate in follow-ups:

| Plugin                                                    | From                                     | To                                                                     |
| --------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `plugins/ocr`                                             | global `installOcrRuntime()`             | `ctx.ocr.registerProvider(...)` or `manifest.ocrProviders[]`           |
| `plugins/e2b-sandbox`                                     | `setE2BBackend()`                        | `ctx.workspace.registerBackend(...)` or `manifest.workspaceBackends[]` |
| `plugins/github-delivery`                                 | side-effect `registerNodeExecutor` (×12) | `manifest.workflows.nodes[]` (already typed)                           |
| `plugins/computer-use`                                    | `registerPluginI18n()` imperative        | `manifest.i18n` (auto-wired)                                           |
| `plugins/workflow-ai`                                     | `registerPluginI18n()` imperative        | `manifest.i18n` (auto-wired)                                           |
| `plugins/{clipboard-history, web-tools, workspace-tools}` | `isTauri()` direct import                | `ctx.capabilities.tauri`                                               |

---

## Risks + mitigations

- **R1 — Middleware-induced latency.** Mitigation: 5s per-middleware timeout, audit telemetry exposes p99 chain latency, runner reports include `timedOut` per turn.
- **R2 — github-delivery migration regression.** Mitigation: legacy side-effect import remains behind `@deprecated`; node-registry change is opt-in per plugin.
- **R3 — Theme CSS injection escapes.** Mitigation: constrained to CSS variable map with regex-validated names, length-capped values, `</style>` rejected.
- **R4 — AI provider scope creep.** Mitigation: locked to plugin-internal use (`ctx.ai.complete`); main chat pipeline never resolves a plugin provider. The around-middleware path (`chat.middleware`) is the only sanctioned route to the main chat flow, and it's gated by `agent:control` + a 3-strike breaker.
- **R5 — Slot un-deprecation drift.** Two slots (`chat.message.actions`, `settings.ai`) flipped deprecated → implemented; both bind to host JSX mounts added in the same change set.

---

## Out of scope

- Mobile signaling / WebRTC plugin integration (separate subsystem).
- VS Code extension reuse layer expansion (separate plan).
- Plugin marketplace install-from-URL.
- Lifting the workspace-backend registry out of `lib/github/` into a `lib/workspace/` namespace.
- Reviving `sidebar.right.*` / `panel.header` / `panel.footer` (no host surfaces exist).
