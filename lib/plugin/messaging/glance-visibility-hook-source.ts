/**
 * The one fire site of the `onGlanceVisibilityChange` hook (ADR-0225 §6).
 *
 * `ctx.glance.onVisibilityChange` hands the host a callback, which cannot
 * cross a Python plugin's stdio boundary, so Python (and any plugin that
 * prefers a hook) hears visibility through this hook instead. The rules
 * match the callback's:
 *
 * - delivered only to the module's own plugin;
 * - once with the current state when the plugin starts listening (its hooks
 *   are registered, or re-registered) and when a module is declared;
 * - then on every flip, from the same registry the callback reads.
 *
 * Reconciling instead of forwarding flips is what makes the first delivery
 * reliable: a Python plugin's hooks are registered after its manifest
 * modules, so a flip that happened in between would otherwise be lost and
 * the plugin would wait for a change that already came.
 *
 * Installed once per plugin runtime by `PluginRuntimeInitializer`, which also
 * disposes it when the runtime is torn down.
 */

import { loggers } from "@cognia/logging"
import { glancePluginModules, type GlancePluginModuleRegistry } from "@/lib/glance/plugin-registry"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginGlanceVisibilityEvent } from "@/types/plugin/plugin-glance"
import { getPluginEventHooks } from "./hooks-system"

const log = loggers.plugin

/** What the source reads from the plugin runtime, injectable for tests. */
export interface GlanceVisibilityHookSourceDeps {
  registry: GlancePluginModuleRegistry
  /** The current hooks object of an enabled plugin, or null. */
  hooksOf: (pluginId: string) => object | null
  /** Hear any plugin-runtime change (hooks registered, a plugin disabled). */
  subscribePlugins: (listener: () => void) => () => void
  dispatch: (pluginId: string, event: PluginGlanceVisibilityEvent) => Promise<unknown>
}

function defaultDeps(): GlanceVisibilityHookSourceDeps {
  return {
    registry: glancePluginModules,
    hooksOf: (pluginId) => {
      const plugin = usePluginStore.getState().plugins[pluginId]
      return plugin?.status === "enabled" && plugin.hooks ? plugin.hooks : null
    },
    subscribePlugins: (listener) => usePluginStore.subscribe(listener),
    dispatch: (pluginId, event) =>
      getPluginEventHooks().dispatchGlanceVisibilityChange(pluginId, event),
  }
}

interface Delivered {
  /** The hooks object the states were delivered to. */
  hooks: object
  /** Last state delivered, per local module id. */
  states: Map<string, boolean>
}

/** Start delivering. Returns the stop function. */
function start(deps: GlanceVisibilityHookSourceDeps): () => void {
  const delivered = new Map<string, Delivered>()

  const send = (pluginId: string, event: PluginGlanceVisibilityEvent) => {
    void deps.dispatch(pluginId, event).catch((error: unknown) =>
      log.warn("glance visibility hook dispatch failed", {
        pluginId,
        moduleId: event.moduleId,
        error: error instanceof Error ? error.message : String(error),
      })
    )
  }

  const reconcile = () => {
    const modulesByPlugin = new Map<string, Array<{ moduleId: string; visible: boolean }>>()
    for (const entry of deps.registry.catalog()) {
      const list = modulesByPlugin.get(entry.pluginId) ?? []
      list.push({ moduleId: entry.def.id, visible: deps.registry.isVisible(entry.entryId) })
      modulesByPlugin.set(entry.pluginId, list)
    }
    for (const pluginId of [...delivered.keys()]) {
      if (!modulesByPlugin.has(pluginId)) delivered.delete(pluginId)
    }
    for (const [pluginId, modules] of modulesByPlugin) {
      const hooks = deps.hooksOf(pluginId)
      const listens =
        hooks !== null &&
        typeof (hooks as { onGlanceVisibilityChange?: unknown }).onGlanceVisibilityChange ===
          "function"
      if (!hooks || !listens) {
        delivered.delete(pluginId)
        continue
      }
      let record = delivered.get(pluginId)
      if (!record || record.hooks !== hooks) {
        // Newly listening (or listening anew): every module's state is news.
        record = { hooks, states: new Map() }
        delivered.set(pluginId, record)
      }
      const live = new Set<string>()
      for (const { moduleId, visible } of modules) {
        live.add(moduleId)
        if (record.states.get(moduleId) === visible) continue
        record.states.set(moduleId, visible)
        send(pluginId, { moduleId, visible })
      }
      for (const moduleId of [...record.states.keys()]) {
        if (!live.has(moduleId)) record.states.delete(moduleId)
      }
    }
  }

  const unsubscribers = [
    deps.registry.subscribe(reconcile),
    deps.registry.subscribeVisibility(reconcile),
    deps.subscribePlugins(reconcile),
  ]
  reconcile()
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
    delivered.clear()
  }
}

let installed: { dispose: () => void; refs: number } | null = null

/**
 * Start delivering `onGlanceVisibilityChange`. Returns a disposer.
 *
 * Reference-counted so a remount (React StrictMode runs effects twice) neither
 * delivers every flip twice nor tears the feed down under a live runtime.
 */
export function installGlanceVisibilityHookSource(
  deps: GlanceVisibilityHookSourceDeps = defaultDeps()
): () => void {
  if (installed) installed.refs += 1
  else installed = { dispose: start(deps), refs: 1 }

  let released = false
  return () => {
    if (released || !installed) return
    released = true
    installed.refs -= 1
    if (installed.refs === 0) {
      installed.dispose()
      installed = null
    }
  }
}

/** Test seam: drop the shared subscription regardless of references. */
export function __resetGlanceVisibilityHookSourceForTesting(): void {
  installed?.dispose()
  installed = null
}
