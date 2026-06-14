/**
 * Plugin Configuration API — typed runtime access to a plugin's own
 * declarative configuration (`manifest.configSchema`). Reads are seeded with
 * schema defaults so a key is non-`undefined` even before the user opens the
 * settings form; `update` validates the changed key against the schema,
 * persists, and fans the change out via the manager's config-change pipeline.
 *
 * `onChange` subscribers fire for changes from ANY source (the settings form,
 * another plugin path, or `ctx.configuration.update`) because the manager calls
 * {@link emitPluginConfigChange} from its `notifyPluginConfigChanged` choke.
 */

import { usePluginStore } from "@/stores/plugin-runtime"
import { setPluginConfig } from "@/lib/db/plugins"
import { validatePluginConfig } from "@/lib/plugin/core/validation"
import { seedPluginConfigDefaults } from "@/lib/plugin/core/config-defaults"
import { loggers } from "../core/logger"
import type { PluginConfigAPI } from "@/types/plugin/plugin-extended"

/** Minimal manager surface the config API depends on (avoids a type cycle). */
interface ConfigManager {
  notifyPluginConfigChanged: (pluginId: string, config: Record<string, unknown>) => Promise<void>
}

// Per-plugin change listeners. Fired by `emitPluginConfigChange`, which the
// manager calls from its single config-change fan-out point.
const listeners = new Map<string, Set<(config: Record<string, unknown>) => void>>()

/** Notify `ctx.configuration.onChange` subscribers for a plugin. */
export function emitPluginConfigChange(pluginId: string, config: Record<string, unknown>): void {
  const set = listeners.get(pluginId)
  if (!set) return
  for (const cb of set) {
    try {
      cb(config)
    } catch (error) {
      loggers.manager.warn(`[plugin:${pluginId}] config onChange listener threw (ignored):`, error)
    }
  }
}

/** Test-only: clear all registered config listeners. */
export function __resetConfigListenersForTesting(): void {
  listeners.clear()
}

export function createConfigAPI(pluginId: string, manager: ConfigManager): PluginConfigAPI {
  function liveConfig(): Record<string, unknown> {
    const plugin = usePluginStore.getState().plugins[pluginId]
    if (!plugin) return {}
    // Seed schema defaults so reads are non-undefined even before persistence.
    return seedPluginConfigDefaults(plugin.manifest, plugin.config)
  }

  return {
    get: <T = unknown>(key: string): T | undefined => liveConfig()[key] as T | undefined,

    getOrDefault: <T = unknown>(key: string, fallback: T): T => {
      const value = liveConfig()[key]
      return value === undefined ? fallback : (value as T)
    },

    getAll: (): Record<string, unknown> => ({ ...liveConfig() }),

    update: async (key: string, value: unknown): Promise<void> => {
      const plugin = usePluginStore.getState().plugins[pluginId]
      const merged = { ...(plugin?.config ?? {}), [key]: value }
      const schema = plugin?.manifest.configSchema
      const result = validatePluginConfig(merged, schema)
      // Only the changed key blocks the write — a missing *unrelated* required
      // field must not prevent updating this key.
      const keyErrors = result.errors.filter(
        (e) => e.field === key || e.field.startsWith(`${key}.`) || e.field.startsWith(`${key}[`)
      )
      if (keyErrors.length > 0) {
        throw new Error(
          `Invalid config for "${key}": ${keyErrors.map((e) => e.message).join("; ")}`
        )
      }
      await setPluginConfig(pluginId, merged)
      usePluginStore.getState().setPluginConfig?.(pluginId, merged)
      await manager.notifyPluginConfigChanged(pluginId, merged)
    },

    onChange: (listener: (config: Record<string, unknown>) => void): (() => void) => {
      let set = listeners.get(pluginId)
      if (!set) {
        set = new Set()
        listeners.set(pluginId, set)
      }
      set.add(listener)
      return () => {
        set?.delete(listener)
      }
    },
  }
}
