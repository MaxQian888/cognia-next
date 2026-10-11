// Plugin-facing glance API (`ctx.glance`, runtime point `glance.module`,
// ADR-0225 §6). A plugin contributes a module to the tray panel and the
// phone's Glance drawer as data; the host renders it with its own
// components. The contract is:
//
//   1. Local module ids map onto the renderer's plugin module registry
//      (`glancePluginModules`, `lib/glance/plugin-registry.ts`) as
//      `plugin:<pluginId>:<id>`, so two plugins can use the same local id.
//   2. `register` declares a module at runtime (the imperative twin of
//      `manifest.glanceModules[]`); its disposer removes it again, or puts
//      back the manifest's declaration when the manifest declares the same id.
//   3. `update` publishes data by local id; `onVisibilityChange` tells the
//      plugin when a module is on screen in any glance build.
//   4. The registry sanitizes and caps everything, and throws a
//      `GlancePluginModuleError` for input that cannot be a module. Those
//      errors reach the plugin author unchanged.
//
// Lifecycle: every disposer is enrolled through the injected `track` (the
// plugin's disposable scope), and the disable teardown drops every module
// of the plugin through the `glance` overlay capability
// (`capability-bridge-map.ts` → `unregisterAllByPlugin`), so a disabled
// plugin leaves nothing behind even when the resource ledger is off.
//
// Capability gating: without the `"glance"` capability every call is a
// warn-once no-op, exactly like `ctx.tray`.

"use client"

import { loggers } from "@cognia/logging"
import type {
  PluginCapability,
  PluginGlanceAPI,
  PluginGlanceModuleData,
  PluginGlanceModuleInput,
} from "@/types/plugin"
import { pluginEntryId } from "@/types/glance/layout"
import { isGlancePluginLocalId, type GlancePluginModuleDef } from "@/lib/glance/plugin-data"
import { GlancePluginModuleError, glancePluginModules } from "@/lib/glance/plugin-registry"
import { recordSilentFailure } from "../contracts/diagnostics-store"

export interface CreateGlanceAPIArgs {
  pluginId: string
  capabilities: readonly PluginCapability[]
  /**
   * Enrol a disposer in the plugin's lifecycle scope and hand back the
   * ledger-bound handle (see `CreateCommandsAPIDependencies.track`). Optional
   * so a bare context still works; the disable teardown is the backstop.
   */
  track?: (dispose: () => void, label: string) => () => void | Promise<void>
}

export function createGlanceAPI({
  pluginId,
  capabilities,
  track,
}: CreateGlanceAPIArgs): PluginGlanceAPI {
  if (!capabilities.includes("glance")) return noopGlanceAPI(pluginId)

  /** The live runtime registration per local id; older ones are superseded. */
  const owner = new Map<string, symbol>()
  /** What the registry held for an id before this plugin first registered it at runtime. */
  const baseline = new Map<string, GlancePluginModuleDef | null>()

  function enrol(dispose: () => void, label: string): () => void {
    let disposed = false
    const once = () => {
      if (disposed) return
      disposed = true
      dispose()
    }
    if (!track) return once
    const handle = track(once, label)
    return () => {
      void Promise.resolve(handle()).catch(() => undefined)
    }
  }

  function register(module: PluginGlanceModuleInput): () => void {
    const localId = (module as { id?: unknown } | null | undefined)?.id
    const entryId = isGlancePluginLocalId(localId) ? pluginEntryId(pluginId, localId) : null
    const previous = entryId ? (glancePluginModules.get(entryId)?.def ?? null) : null

    // Throws GlancePluginModuleError for an invalid declaration or past the
    // per-plugin limit, before any local bookkeeping happens.
    const registered = glancePluginModules.register(pluginId, module)
    const id = localId as string
    if (!owner.has(id)) baseline.set(id, previous)
    const token = Symbol(id)
    owner.set(id, token)

    return enrol(() => {
      // A newer `register` of the same id governs it now.
      if (owner.get(id) !== token) return
      owner.delete(id)
      const restore = baseline.get(id) ?? null
      baseline.delete(id)
      // The plugin was already torn down (disable dropped every module):
      // nothing to remove, and nothing may be resurrected.
      if (!glancePluginModules.get(registered)) return
      if (restore) glancePluginModules.register(pluginId, restore)
      else glancePluginModules.unregister(registered)
    }, `ctx.glance.register:${id}`)
  }

  function update(moduleId: string, data: PluginGlanceModuleData | null): void {
    glancePluginModules.update(pluginId, moduleId, data)
  }

  function onVisibilityChange(moduleId: string, handler: (visible: boolean) => void): () => void {
    if (!isGlancePluginLocalId(moduleId)) {
      throw new GlancePluginModuleError(
        `"${String(moduleId)}" is not a glance module id (letters, digits, . _ -)`
      )
    }
    if (typeof handler !== "function") {
      throw new TypeError("ctx.glance.onVisibilityChange needs a handler function")
    }
    // A throwing handler must neither break the subscription (the registry
    // calls it at once, before handing back the disposer) nor the host.
    const safe = (visible: boolean) => {
      try {
        handler(visible)
      } catch (error) {
        recordSilentFailure(
          pluginId,
          {
            site: "glance.onVisibilityChange",
            message: `Glance visibility handler for ${moduleId} threw`,
            expected: false,
          },
          error
        )
      }
    }
    const unsubscribe = glancePluginModules.onVisibilityChange(
      pluginEntryId(pluginId, moduleId),
      safe
    )
    return enrol(unsubscribe, `ctx.glance.onVisibilityChange:${moduleId}`)
  }

  return { register, update, onVisibilityChange }
}

function noopGlanceAPI(pluginId: string): PluginGlanceAPI {
  const warnOnce = createWarnOnce(pluginId)
  return {
    register: () => {
      warnOnce()
      return () => {}
    },
    update: () => {
      warnOnce()
    },
    onVisibilityChange: () => {
      warnOnce()
      return () => {}
    },
  }
}

function createWarnOnce(pluginId: string): () => void {
  let warned = false
  return () => {
    if (warned) return
    warned = true
    loggers.plugin.warn(
      "plugin tried to use ctx.glance without the 'glance' capability — declare it in plugin.json",
      { pluginId }
    )
  }
}
