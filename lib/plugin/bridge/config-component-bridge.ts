/**
 * Config Component Bridge.
 *
 * Resolves `manifest.configComponent` on demand — the host's per-plugin
 * settings panel calls `loadConfigComponent(manifest, installRoot)` when
 * the user opens the plugin's settings tab. The bridge dynamic-imports
 * `entry` and returns the named React component.
 *
 * Result is cached per pluginId so subsequent renders are zero-cost. The
 * cache is invalidated by `invalidateConfigComponentForPlugin(pluginId)`,
 * which the plugin manager calls on disable / reload.
 *
 * The host falls back to the generic JSON-schema-driven form (derived
 * from `configSchema`) when this bridge returns `null` — i.e. the plugin
 * didn't declare `configComponent` or the load errored.
 *
 * ADR-0026 §3 §B.
 */

import type React from "react"
import type { PluginManifest } from "@/types/plugin/plugin"
import { loggers } from "@/lib/plugin/core/logger"

export interface ConfigComponentProps {
  /** Current resolved config (post-`configSchema` defaults merge). */
  config: Record<string, unknown>
  /** Persist a new config object. Returns once storage has flushed. */
  onSave(next: Record<string, unknown>): Promise<void>
  /** Plugin id — useful for routing inside the component. */
  pluginId: string
}

export type ConfigComponent = React.ComponentType<ConfigComponentProps>

interface CacheEntry {
  component: ConfigComponent | null
  error?: string
}

const cache = new Map<string, CacheEntry>()

export interface LoadConfigComponentOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}

const DEFAULT_IMPORTER: NonNullable<LoadConfigComponentOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

export async function loadConfigComponent(
  manifest: PluginManifest,
  installRoot: string,
  options: LoadConfigComponentOptions = {}
): Promise<ConfigComponent | null> {
  const pluginId = manifest.id
  const def = manifest.configComponent
  if (!def) {
    return null
  }
  const cached = cache.get(pluginId)
  if (cached) {
    return cached.component
  }
  try {
    const importer = options.importer ?? DEFAULT_IMPORTER
    const resolved = `${installRoot.replace(/[\\/]+$/, "")}/${def.entry.replace(/^[\\/]+/, "")}`
    const mod = await importer(resolved)
    const exported = mod[def.export]
    if (typeof exported !== "function") {
      throw new Error(
        `configComponent.entry "${def.entry}" does not export a React component named "${def.export}"`
      )
    }
    const component = exported as ConfigComponent
    cache.set(pluginId, { component })
    return component
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cache.set(pluginId, { component: null, error: message })
    loggers.manager.warn(`[config-component-bridge] failed to load for ${pluginId}: ${message}`)
    return null
  }
}

/** Cached entry, if any. */
export function peekConfigComponent(pluginId: string): CacheEntry | undefined {
  return cache.get(pluginId)
}

/** Invalidate the cache for a plugin (called on disable / reload). */
export function invalidateConfigComponentForPlugin(pluginId: string): void {
  cache.delete(pluginId)
}

/** Test-only — wipe the entire cache. */
export function __resetConfigComponentBridgeForTesting(): void {
  cache.clear()
}
