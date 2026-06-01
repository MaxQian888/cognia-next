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
 * BACKGROUND: these 7 bridges were each built and unit-tested (ADR-0016 /
 * ADR-0026) but the call wiring them into the manager enable flow was never
 * added — they silently no-op'd at runtime. This table is that wiring.
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
  /** Sync relative-asset → loadable-URL resolver (fonts/wallpapers). */
  resolveAsset: PluginAssetResolver
  /** The plugin's already-loaded main-module exports (connectors factories). */
  moduleExports: Record<string, unknown>
}

export interface ModuleBridgeCapabilityDescriptor {
  /** Capability tag, or a synthetic label where no capability exists yet. */
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
 * The async module-bridge capabilities. Keyed by capability tag (or synthetic
 * label where the capability union has no matching tag yet — `workspace-backend`
 * and `message-renderer`). The dispatch loop is FIELD-driven (it gates on
 * `manifest[manifestField]?.length`), so a synthetic key never blocks a plugin.
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
    // No capability tag in the union yet (synthetic key). Field-driven gating
    // means a plugin declaring `workspaceBackends` is still wired regardless.
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
    // Synthetic key. Resolves the historical asymmetry: the manager already
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
      applyPluginWallpapers({
        pluginId: ctx.pluginId,
        pluginRoot: ctx.installRoot,
        wallpapers: ctx.manifest.wallpapers ?? [],
        resolveAsset: ctx.resolveAsset,
      })
    },
    unregister: (pluginId) => {
      revertPluginWallpapers(pluginId)
    },
  },
  "density-preset": {
    // Pure in-memory registry (no async/import) — registered so theme packs
    // (and `applyDensityPresetVars`) can resolve presets by name. Synthetic key.
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
    // Synthetic key. Declarative `manifest.chatMiddlewares[]` → the
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
    // Synthetic key. Declarative `manifest.modalMounts[]` → the modal store's
    // lazy declared-modal registry. Field-driven gating; the component is not
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
    // Synthetic key. Declarative `manifest.terminalCompletionProviders[]` →
    // the terminal completion registry (ADR-0039). Lazy-factory entries are
    // imported on enable; providers feed the integrated terminal's inline
    // ghost text. Field-driven gating. Permission gate: `terminal:completion`.
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
} as const satisfies Record<string, ModuleBridgeCapabilityDescriptor>

export type ModuleBridgeCapability = keyof typeof MODULE_BRIDGE_CAPABILITIES

/**
 * List the manager's dispatch loop iterates, derived from the map keys so a
 * future addition automatically widens the loop.
 */
export const MODULE_BRIDGE_CAPABILITY_KEYS: ReadonlyArray<ModuleBridgeCapability> = Object.keys(
  MODULE_BRIDGE_CAPABILITIES
) as ReadonlyArray<ModuleBridgeCapability>
