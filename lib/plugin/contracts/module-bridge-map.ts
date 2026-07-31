/**
 * Codified registry: which `PluginManifest` contribution fields are wired
 * through an ASYNC module-loading bridge on plugin enable/disable.
 *
 * This is the async sibling of `capability-bridge-map.ts`
 * (`OVERLAY_REGISTRY_CAPABILITIES`). The overlay map handles capabilities
 * whose entries are plain inline defs registered synchronously. The
 * capabilities here are different in two ways the overlay shape can't express:
 *
 *   1. They are ASYNC — each bridge dynamic-imports a lazy-factory `entry`
 *      module (or, for connectors, reads the plugin's already-loaded exports)
 *      before it can register anything.
 *   2. Their bridge signatures differ (`(manifest, installRoot, { importer })`
 *      for the import-based ones; `(pluginId, manifest, exports)` for
 *      connectors; `({ pluginId, pluginRoot, …, resolveAsset })` for the
 *      asset-based font/wallpaper bridges).
 *
 * Each descriptor normalizes its bridge behind a single uniform
 * `register(ctx) => Promise<void>` / `unregister(pluginId) => void` pair, so
 * `PluginManager.registerPluginContributions` /
 * `unregisterPluginContributions` can drive all of them with one `await`
 * loop — exactly mirroring the overlay dispatch. Adding a future async-bridge
 * capability is one map entry away from being picked up.
 *
 * BACKGROUND: this table started as the missing manager wiring for the
 * ADR-0016 / ADR-0026 module bridges. It now remains the canonical dispatch
 * point for every field-driven async or asset-backed contribution.
 *
 * A CI-gated test (`module-bridge-map.test.ts`) walks the map and asserts each
 * entry's `manifestField` is a real `PluginManifest` key and both functions
 * are present, so a future refactor that drops a bridge export fails loudly.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginAssetResolver } from "@/lib/plugin/core/plugin-asset-resolver"
import {
  registerAiProvidersForPlugin,
  unregisterAiProvidersForPlugin,
} from "@/lib/plugin/bridge/ai-providers-bridge"
import {
  registerOcrProvidersForPlugin,
  unregisterOcrProvidersForPlugin,
} from "@/lib/plugin/bridge/ocr-providers-bridge"
import {
  registerWorkspaceBackendsForPlugin,
  unregisterWorkspaceBackendsForPlugin,
} from "@/lib/plugin/bridge/workspace-backend-bridge"
import {
  registerMessageRenderersForPlugin,
  unregisterMessageRenderersForPlugin,
} from "@/lib/plugin/bridge/message-renderer-bridge"
import {
  registerToolRenderersForPlugin,
  unregisterToolRenderersForPlugin,
} from "@/lib/plugin/bridge/tool-renderer-bridge"
import { registerViewsForPlugin, unregisterViewsForPlugin } from "@/lib/plugin/bridge/view-bridge"
import {
  registerWebviewsForPlugin,
  unregisterWebviewsForPlugin,
} from "@/lib/plugin/bridge/plugin-webview-bridge"
import {
  registerPluginAdapters,
  unregisterPluginAdapters,
} from "@/lib/plugin/bridge/connectors-bridge"
import { applyPluginFonts, revertPluginFonts } from "@/lib/plugin/bridge/font-bridge"
import { applyPluginWallpapers, revertPluginWallpapers } from "@/lib/plugin/bridge/wallpaper-bridge"
import {
  registerScheduledTasksForPlugin,
  unregisterScheduledTasksForPlugin,
} from "@/lib/plugin/bridge/scheduled-task-bridge"
import {
  registerModalMountsForPlugin,
  unregisterModalMountsForPlugin,
} from "@/lib/plugin/bridge/modal-mount-bridge"
import {
  registerChatMiddlewaresForPlugin,
  unregisterChatMiddlewaresForPlugin,
} from "@/lib/plugin/bridge/chat-middleware-bridge"
import {
  registerTerminalCompletionProvidersForPlugin,
  unregisterTerminalCompletionProvidersForPlugin,
} from "@/lib/plugin/bridge/terminal-completion-bridge"
import {
  registerDensityPresetsForPlugin,
  unregisterDensityPresetsByPlugin,
} from "@/lib/appearance/density-preset-registry"
import {
  registerRoutingStrategiesForPlugin,
  unregisterRoutingStrategiesForPlugin,
} from "@/lib/plugin/bridge/routing-strategies-bridge"
import {
  registerDeploymentFiltersForPlugin,
  unregisterDeploymentFiltersForPlugin,
} from "@/lib/plugin/bridge/deployment-filters-bridge"
import {
  registerProtocolAdaptersForPlugin,
  unregisterProtocolAdaptersForPlugin,
} from "@/lib/plugin/bridge/protocol-adapters-bridge"
import {
  registerExternalAgentAdaptersForPlugin,
  unregisterExternalAgentAdaptersForPlugin,
} from "@/lib/plugin/bridge/external-agent-adapters-bridge"
import {
  registerSessionImportersForPlugin,
  unregisterSessionImportersForPlugin,
} from "@/lib/plugin/bridge/session-importers-bridge"
import {
  registerToolRoutesForPlugin,
  unregisterToolRoutesForPlugin,
} from "@/lib/plugin/bridge/tool-routes-bridge"
import {
  registerContextProvidersForPlugin,
  unregisterContextProvidersForPlugin,
} from "@/lib/plugin/bridge/context-providers-bridge"
import {
  registerContextPanelsForPlugin,
  unregisterContextPanelsForPlugin,
} from "@/lib/plugin/bridge/context-panels-bridge"
import {
  registerIntegrationsForPlugin,
  unregisterIntegrationsForPlugin,
} from "@/lib/plugin/bridge/integrations-bridge"

/**
 * Everything a module-bridge descriptor may need to register a plugin's
 * contributions. The manager builds one per enable. `importer`/`moduleExports`
 * are used by the JS-entry bridges; `resolveAsset` by the asset bridges.
 */
export interface ModuleBridgeContext {
  pluginId: string
  manifest: PluginManifest
  /** Absolute (Tauri) or served (web) plugin install root — `plugin.path`. */
  installRoot: string
  /** Resolve & import a plugin entry module by absolute path. */
  importer: (entry: string) => Promise<Record<string, unknown>>
  /** Contained relative-asset → loadable-URL resolver (fonts/wallpapers). */
  resolveAsset: PluginAssetResolver
  /** The plugin's already-loaded main-module exports (connectors factories). */
  moduleExports: Record<string, unknown>
  /** Live permission resolver; reflects revocation without re-enabling. */
  hasPermission: (permission: string) => boolean
}

export interface ModuleBridgeCapabilityDescriptor {
  /** Capability tag used by the contract catalog and SDK helper map. */
  key: string
  /** The `PluginManifest` array field whose presence gates this bridge. */
  manifestField: keyof PluginManifest
  /** Register every contribution for the plugin. Throws are caught by the loop. */
  register: (ctx: ModuleBridgeContext) => Promise<void>
  /**
   * Idempotently drop every contribution the named plugin made. May be async
   * (e.g. the scheduler bridge deletes persisted Dexie rows); the manager
   * awaits it.
   */
  unregister: (pluginId: string) => void | Promise<void>
}

/**
 * The async module-bridge capabilities. Keyed by capability tag and dispatched
 * by manifest field presence (`manifest[manifestField]?.length`) so bridge
 * registration stays compatible with declarative contribution arrays.
 */
export const MODULE_BRIDGE_CAPABILITIES = {
  "ai-provider": {
    key: "ai-provider",
    manifestField: "aiProviders",
    register: async (ctx) => {
      await registerAiProvidersForPlugin(ctx.manifest, ctx.installRoot, { importer: ctx.importer })
    },
    unregister: unregisterAiProvidersForPlugin,
  },
  media: {
    // OCR providers are the media-capability contribution surface.
    key: "media",
    manifestField: "ocrProviders",
    register: async (ctx) => {
      await registerOcrProvidersForPlugin(ctx.manifest, ctx.installRoot, { importer: ctx.importer })
    },
    unregister: unregisterOcrProvidersForPlugin,
  },
  "workspace-backend": {
    // Canonical field-driven capability. A plugin declaring
    // `workspaceBackends` is wired through the workspace backend registry.
    key: "workspace-backend",
    manifestField: "workspaceBackends",
    register: async (ctx) => {
      await registerWorkspaceBackendsForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
      })
    },
    unregister: unregisterWorkspaceBackendsForPlugin,
  },
  "message-renderer": {
    // Canonical field-driven capability. Resolves the historical asymmetry:
    // the manager already
    // tore renderers down on disable (purgeMessagePartRenderersForPlugin) but
    // never registered them on enable. Both paths call
    // `clearMessagePartRenderersForPlugin`, so routing unregister here is
    // behaviour-identical.
    key: "message-renderer",
    manifestField: "messageRenderers",
    register: async (ctx) => {
      await registerMessageRenderersForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
      })
    },
    unregister: unregisterMessageRenderersForPlugin,
  },
  "tool-renderer": {
    // Companion to `message-renderer`. Tool parts never reach the message-part
    // registry (the host claims `tool-*` / `dynamic-tool` before it is
    // consulted), so a plugin shipping an MCP tool needs this separate seam to
    // render its own result richly.
    key: "tool-renderer",
    manifestField: "toolRenderers",
    register: async (ctx) => {
      await registerToolRenderersForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
      })
    },
    unregister: unregisterToolRenderersForPlugin,
  },
  connectors: {
    // Different arg order + needs the plugin's loaded exports (factory lookup
    // by name) rather than a per-entry importer. The manager supplies
    // `moduleExports` from the loader's cache.
    key: "connectors",
    manifestField: "connectors",
    register: async (ctx) => {
      await registerPluginAdapters(ctx.pluginId, ctx.manifest, ctx.moduleExports)
    },
    unregister: unregisterPluginAdapters,
  },
  integrations: {
    key: "integrations",
    manifestField: "integrations",
    register: async (ctx) => {
      await registerIntegrationsForPlugin(ctx.pluginId, ctx.manifest, ctx.moduleExports)
    },
    unregister: unregisterIntegrationsForPlugin,
  },
  fonts: {
    key: "fonts",
    manifestField: "fonts",
    register: async (ctx) => {
      await applyPluginFonts({
        pluginId: ctx.pluginId,
        pluginRoot: ctx.installRoot,
        fonts: ctx.manifest.fonts ?? [],
        resolveAsset: ctx.resolveAsset,
      })
    },
    unregister: (pluginId) => {
      revertPluginFonts(pluginId)
    },
  },
  wallpapers: {
    key: "wallpapers",
    manifestField: "wallpapers",
    register: async (ctx) => {
      const resolved = new Map<string, string>()
      for (const wallpaper of ctx.manifest.wallpapers ?? []) {
        if (wallpaper.source.kind === "image") {
          resolved.set(
            wallpaper.source.relPath,
            await ctx.resolveAsset(ctx.installRoot, wallpaper.source.relPath, wallpaper.source.mime)
          )
        }
      }
      applyPluginWallpapers({
        pluginId: ctx.pluginId,
        pluginRoot: ctx.installRoot,
        wallpapers: ctx.manifest.wallpapers ?? [],
        resolveAsset: (_root, relPath) => {
          const url = resolved.get(relPath)
          if (!url) throw new Error(`wallpaper asset was not resolved: ${relPath}`)
          return url
        },
      })
    },
    unregister: (pluginId) => {
      revertPluginWallpapers(pluginId)
    },
  },
  "density-preset": {
    // Pure in-memory registry (no async/import) — registered so theme packs
    // (and `applyDensityPresetVars`) can resolve presets by name.
    key: "density-preset",
    manifestField: "densityPresets",
    register: async (ctx) => {
      registerDensityPresetsForPlugin(ctx.pluginId, ctx.manifest.densityPresets ?? [])
    },
    unregister: (pluginId) => {
      unregisterDensityPresetsByPlugin(pluginId)
    },
  },
  "chat-middleware": {
    // Canonical field-driven capability. Declarative
    // `manifest.chatMiddlewares[]` → the
    // chat-middleware registry. Registration always happens; EXECUTION is
    // gated behind a default-off flag at the send call-site
    // (lib/claude/chat-middleware/feature-flag.ts), so wiring this never
    // changes default chat behaviour.
    key: "chat-middleware",
    manifestField: "chatMiddlewares",
    register: async (ctx) => {
      await registerChatMiddlewaresForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
      })
    },
    unregister: (pluginId) => {
      unregisterChatMiddlewaresForPlugin(pluginId)
    },
  },
  "modal-mount": {
    // Canonical field-driven capability. Declarative `manifest.modalMounts[]`
    // → the modal store's lazy declared-modal registry. The component is not
    // imported until the modal is actually opened.
    key: "modal-mount",
    manifestField: "modalMounts",
    register: async (ctx) => {
      await registerModalMountsForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
      })
    },
    unregister: (pluginId) => {
      unregisterModalMountsForPlugin(pluginId)
    },
  },
  "terminal-completion": {
    // Canonical field-driven capability. Declarative
    // `manifest.terminalCompletionProviders[]` → the terminal completion
    // registry (ADR-0039). Lazy-factory entries are imported on enable;
    // providers feed the integrated terminal's inline ghost text. Permission
    // gate: `terminal:completion`.
    key: "terminal-completion",
    manifestField: "terminalCompletionProviders",
    register: async (ctx) => {
      await registerTerminalCompletionProvidersForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
      })
    },
    unregister: (pluginId) => {
      unregisterTerminalCompletionProvidersForPlugin(pluginId)
    },
  },
  "routing-strategy": {
    // Canonical field-driven capability. Declarative
    // `manifest.routingStrategies[]` (ADR-0026 lazy factories) → the routing
    // strategy registry under `${pluginId}:${id}`. The engine try-catches
    // every selector call, so a broken custom strategy degrades to chain order
    // instead of breaking dispatch.
    key: "routing-strategy",
    manifestField: "routingStrategies",
    register: async (ctx) => {
      await registerRoutingStrategiesForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
      })
    },
    unregister: (pluginId) => {
      unregisterRoutingStrategiesForPlugin(pluginId)
    },
  },
  "deployment-filter": {
    // Canonical field-driven capability. Declarative
    // `manifest.deploymentFilters[]` (ADR-0026 lazy factories) → the
    // deployment-filter registry under `${pluginId}:${id}`. The chain runner
    // try-catches every filter call, so a broken custom filter is skipped
    // instead of breaking dispatch; users opt filters into the chain via
    // `RoutingConfig.filterChain`.
    key: "deployment-filter",
    manifestField: "deploymentFilters",
    register: async (ctx) => {
      await registerDeploymentFiltersForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
      })
    },
    unregister: (pluginId) => {
      unregisterDeploymentFiltersForPlugin(pluginId)
    },
  },
  "protocol-adapter": {
    // Canonical field-driven capability. Declarative
    // `manifest.protocolAdapters[]`
    // (openai-compatible-variant specs — pure DATA, no dynamic import) →
    // the renderer protocol-adapter registry under `${pluginId}:${id}`.
    // build-options forwards the spec to the sidecar per-send; the sidecar
    // executes it without ever loading plugin code.
    key: "protocol-adapter",
    manifestField: "protocolAdapters",
    register: async (ctx) => {
      await registerProtocolAdaptersForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
      })
    },
    unregister: (pluginId) => {
      unregisterProtocolAdaptersForPlugin(pluginId)
    },
  },
  "external-agent-adapter": {
    // Declarative `manifest.externalAgentAdapters[]` (ADR-0026 lazy factories)
    // → the external-agent `protocolAdapterRegistry` under `${pluginId}:${id}`.
    // Lets a plugin contribute a brand-new external-agent protocol (the
    // targeted-behaviour twin of the preset overlay). The manager's addAgent
    // resolves the adapter via `protocolAdapterRegistry.create(protocol)`, so a
    // contributed adapter is indistinguishable from a built-in once registered.
    key: "external-agent-adapter",
    manifestField: "externalAgentAdapters",
    register: async (ctx) => {
      await registerExternalAgentAdaptersForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
      })
    },
    // Async: disable also tears down the live agents (and their spawned
    // processes) this plugin's protocols back — see the bridge.
    unregister: async (pluginId) => {
      await unregisterExternalAgentAdaptersForPlugin(pluginId)
    },
  },
  "session-importer": {
    // Declarative `manifest.sessionImporters[]` (ADR-0062 lazy factories) → the
    // session-source registry under `${pluginId}:${id}`. Lets a plugin add a new
    // agent's on-disk session-history importer with no host change. Stateless —
    // disable is a plain registry removal (no live agents to tear down).
    key: "session-importer",
    manifestField: "sessionImporters",
    register: async (ctx) => {
      await registerSessionImportersForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
      })
    },
    unregister: (pluginId) => {
      unregisterSessionImportersForPlugin(pluginId)
    },
  },
  "tool-route": {
    // Canonical field-driven capability. Declarative `manifest.toolRoutes[]`
    // (semantic routing utterances) → persisted Dexie `toolRoutes` rows
    // (source "manifest"). Data rows rather than lazy factories; disable
    // deletes them — hence the async unregister.
    key: "tool-route",
    manifestField: "toolRoutes",
    register: async (ctx) => {
      await registerToolRoutesForPlugin(ctx.manifest, ctx.installRoot)
    },
    unregister: async (pluginId) => {
      await unregisterToolRoutesForPlugin(pluginId)
    },
  },
  "context-provider": {
    // Canonical field-driven capability. Declarative
    // `manifest.contextProviders[]` lazy factories → registered into the
    // context-provider registry under `${pluginId}:${id}` and consumed by
    // `resolveContextContributions` (agent-sdk).
    key: "context-provider",
    manifestField: "contextProviders",
    register: async (ctx) => {
      await registerContextProvidersForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
      })
    },
    unregister: (pluginId) => {
      unregisterContextProvidersForPlugin(pluginId)
    },
  },
  "context-panel": {
    key: "context-panel",
    manifestField: "contextPanels",
    register: async (ctx) => {
      await registerContextPanelsForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
        hasPermission: ctx.hasPermission,
      })
    },
    unregister: unregisterContextPanelsForPlugin,
  },
  scheduler: {
    // Creates real, firing `ScheduledTask` rows (type "plugin") in the Dexie
    // scheduler store, idempotent across restarts. Disable deletes them — hence
    // the async unregister.
    key: "scheduler",
    manifestField: "scheduledTasks",
    register: async (ctx) => {
      await registerScheduledTasksForPlugin(ctx.manifest)
    },
    unregister: async (pluginId) => {
      await unregisterScheduledTasksForPlugin(pluginId)
    },
  },
  view: {
    // B2. Tree data providers + custom React views. The bridge dynamic-imports
    // each `manifest.views[]` entry and registers a resolved view into the
    // tree-view registry; the container panel renders them.
    key: "view",
    manifestField: "views",
    register: async (ctx) => {
      await registerViewsForPlugin(ctx.manifest, ctx.installRoot, { importer: ctx.importer })
    },
    unregister: (pluginId) => {
      unregisterViewsForPlugin(pluginId)
    },
  },
  webview: {
    // B3. Sandboxed HTML webviews. The bridge resolves each `manifest.webviews[]`
    // body (inline or imported), wraps it with a CSP from networkAccess, and
    // registers the srcDoc; the container panel renders it in a sandboxed iframe.
    key: "webview",
    manifestField: "webviews",
    register: async (ctx) => {
      // `hasPermission` is forwarded for the editor RPC server the bridge
      // attaches to `editor`-capability webviews — it must see live grants, not
      // a snapshot taken at enable.
      await registerWebviewsForPlugin(ctx.manifest, ctx.installRoot, {
        importer: ctx.importer,
        hasPermission: ctx.hasPermission,
      })
    },
    unregister: (pluginId) => {
      unregisterWebviewsForPlugin(pluginId)
    },
  },
} as const satisfies Record<string, ModuleBridgeCapabilityDescriptor>

export type ModuleBridgeCapability = keyof typeof MODULE_BRIDGE_CAPABILITIES

/**
 * List the manager's dispatch loop iterates, derived from the map keys so a
 * future addition automatically widens the loop.
 */
export const MODULE_BRIDGE_CAPABILITY_KEYS: ReadonlyArray<ModuleBridgeCapability> = Object.keys(
  MODULE_BRIDGE_CAPABILITIES
) as ReadonlyArray<ModuleBridgeCapability>
