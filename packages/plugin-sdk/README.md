# @cognia/plugin-sdk

TypeScript SDK for authoring Cognia plugins. This package is a **stable public façade** over the host runtime's plugin contracts — manifest schema, plugin context, capability helpers, registry functions, and hook/event types.

The SDK contains **no original logic**: every export is a re-export from the canonical source-of-truth modules under `lib/plugin/` and `types/plugin/`. Plugin authors get a stable import path that survives internal refactors of the host runtime.

## Quick start

```ts
import { definePlugin } from "@cognia/plugin-sdk/manifest"
import type { PluginContext } from "@cognia/plugin-sdk/context"
import {
  defineNativeAnthropicTool,
  registerNativeAnthropicTool,
} from "@cognia/plugin-sdk/api/native-anthropic-tool"

const tool = defineNativeAnthropicTool({
  id: "screenshot",
  name: "screenshot",
  type: "computer_20251124",
  executeIpc: { invoke: "plugin_screenshot_take" },
})

export default definePlugin({
  manifest: {
    id: "com.example.screenshot",
    name: "Screenshot",
    version: "0.1.0",
    description: "Capture the screen.",
    type: "frontend",
    capabilities: ["native-anthropic-tool"],
    main: "src/index.ts",
    nativeAnthropicTools: [tool],
  },
  async activate(ctx: PluginContext) {
    registerNativeAnthropicTool(ctx.pluginId, tool)
  },
})
```

## Subpath exports

| Subpath                                        | What it gives you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cognia/plugin-sdk`                           | Convenience barrel re-exporting every subpath below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `@cognia/plugin-sdk/manifest`                  | `PluginManifest`, `PluginCapability`, `PluginDefinition`, `definePlugin`, manifest sub-blocks (`PluginManifestDexieBlock`, `PluginManifestWorkflowsBlock`, scheduler triggers).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `@cognia/plugin-sdk/context`                   | `PluginContext` plus every per-field API: `PluginLogger`, `PluginStorage`, `PluginEventEmitter`, `PluginUIAPI`, `PluginA2UIAPI`, `PluginAgentAPI`, `PluginSettingsAPI`, `PluginNetworkAPI`, `PluginFileSystemAPI`, `PluginClipboardAPI`, `PluginShellAPI`, `PluginDatabaseAPI`, `PluginShortcutsAPI`, `PluginContextMenuAPI`, `PluginTrayAPI`, `PluginWindowAPI`, `PluginSecretsAPI`, `PluginSchedulerAPI`, `PluginWorkflowAPI`, `PluginDexieAPI`, plus extended-context types (`PluginSessionAPI`, `PluginProjectAPI`, `PluginVectorAPI`, `PluginThemeAPI`, `PluginI18nAPI`, `PluginCanvasAPI`, `PluginArtifactAPI`, `PluginNotificationCenterAPI`, `PluginStorageAPI`, `PluginAIProviderAPI`, `PluginExportAPI`, `PluginExtensionAPI`, `PluginPermissionAPI`). |
| `@cognia/plugin-sdk/context/extended`          | Original subpath that the `native-anthropic-tool` capability contract advertises. Kept for back-compat — re-exports the same types as `/context`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@cognia/plugin-sdk/api/native-anthropic-tool` | `defineNativeAnthropicTool`, `registerNativeAnthropicTool`, `unregisterNativeAnthropicToolById`, `unregisterNativeAnthropicToolsByPlugin`, `getNativeAnthropicTool`, `getNativeAnthropicToolEntry`, `listNativeAnthropicToolIds`, `listNativeAnthropicToolEntries`, `computeAnthropicBetaHeaders`, plus the matching types.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@cognia/plugin-sdk/api/skill`                 | `defineSkill`, `registerSkill`, `unregisterSkillById`, `unregisterSkillsByPlugin`, `getSkill`, `getSkillEntry`, `listSkillIds`, `listSkillEntries`, plus `PluginSkillDef` and `PluginSkillSource`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@cognia/plugin-sdk/api/mcp-server-preset`     | `defineMcpServerPreset`, `registerMcpServerPreset`, `unregisterMcpServerPresetById`, `unregisterMcpServerPresetsByPlugin`, `getMcpServerPreset`, `getMcpServerPresetEntry`, `listMcpServerPresetIds`, `listMcpServerPresetEntries`, plus `PluginMcpServerPresetDef`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `@cognia/plugin-sdk/api/workflow`              | `PluginNodeDef`, `PluginTriggerDef`, `PluginNodeExecuteFn`, `PluginTriggerHandle`, `PluginTriggerStartContext`, `PluginTriggerLogger`, `PluginManifestNodeDef`, `PluginManifestTriggerDef`, `PluginManifestWorkflowsBlock`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@cognia/plugin-sdk/events`                    | `BusEvent`, `EventSource`, `EventSubscription`, `EventFilter`, `SystemEvents` (const), plus the `PluginEventAPI` interface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@cognia/plugin-sdk/hooks`                     | `HookPriority` (enum), `HookRegistration`, `HookExecutionConfig`, `HookMiddleware`, `HookSandboxExecutionResult`, plus the type-only re-export of every event-hook shape (`ProjectHookEvents`, `CanvasHookEvents`, `ArtifactHookEvents`, etc.) and the umbrella `PluginHooksAll` / `ExtendedPluginHooks` types.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `@cognia/plugin-sdk/permissions`               | `PluginPermission`, `PluginPermissionDecision`, `PluginPermissionPolicy`, `PluginAPIPermission`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `@cognia/plugin-sdk/extensions`                | `CanonicalExtensionPoint` (type), `ExtensionPoint` (alias), `ExtensionOptions`, `ExtensionRegistration`, `ExtensionProps`, plus the `CANONICAL_EXTENSION_POINTS` const and the read-only helper `getExtensionPointContract`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## What this package is not

- **Not publishable to npm as-is.** The SDK re-exports types from `@/lib/plugin/*` and `@/types/plugin/*` — paths that live outside this package. Inside the cognia-next monorepo that resolves cleanly through the shared `tsconfig.json` path alias. To publish externally you would either flip the dependency direction (move the source-of-truth modules into this package) or run a bundling build that vendors the cross-package re-exports into `dist/`. Both are deliberate follow-ups; see the project plan for context.
- **Not a renderer.** UI extension slots (`<PluginExtensionSlot id="..." />`) are mounted by the host. Plugins use `ctx.ui` or the extension API on `PluginContext`; the SDK only re-exports the contract enum so authors can reference slot IDs.
- **Not an MCP-tool registration surface.** Plugins cannot yet contribute MCP tools to the external bridge (per ADR-0008). The host owns that surface.
- **Not a permission/consent overlay.** Generic HITL consent does not exist yet — Computer Use has a bespoke flow. Plugins declare `permissions` in the manifest and use `ctx.settings` / `ctx.storage` for user-visible consent state.

## i18n

Plugins ship locale files (e.g. `locales/en.json`, `locales/zh-CN.json`) and declare them in the manifest's `i18n` block. At runtime the host merges them under the `plugin.<id>.*` namespace in `next-intl`. Plugins read translations through `ctx.i18n` (type re-exported from `@cognia/plugin-sdk/context`).

## WIT contract (WASM plugins)

The WIT interface for WASM plugins is mirrored at `plugin-sdk/wit/cognia-plugin.wit` — the canonical source remains `src-tauri/wit/cognia-plugin.wit`. Run `pnpm sync:plugin-sdk-wit` after editing the source, and `pnpm lint:plugin-sdk-wit` (or rely on CI) to fail builds when the two files drift.

## Versioning

Version `0.1.0` tracks WIT contract `cognia:plugin@0.1.0` (see ADR-0013). Bumping the SDK minor version is reserved for additive surface changes; major bumps follow the WIT contract major.
