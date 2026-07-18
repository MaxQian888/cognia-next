/**
 * Routing Strategies Bridge.
 *
 * Resolves `manifest.routingStrategies` contributions on plugin enable
 * (synthetic module-bridge key — field-driven, no capability tag, same
 * posture as `workspace-backend`). Each entry is an ADR-0026 lazy
 * factory `{ id, label, entry, export }`: the bridge dynamic-imports the
 * entry, calls the factory, and registers the returned selector into the
 * routing strategy registry under the namespaced id
 * `${pluginId}:${def.id}`.
 *
 * Safety: the registry refuses built-in ids, the engine try-catches every
 * selector call (a throwing custom strategy degrades to the first chain
 * entry), and disable drops all of a plugin's strategies in one call.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  PluginRoutingStrategyDef,
  PluginRoutingStrategyFactory,
} from "@/types/plugin/plugin-routing-strategy"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  registerRoutingStrategy,
  unregisterRoutingStrategiesByPlugin,
} from "@cognia/provider-routing/strategy-registry"

export interface RoutingStrategiesBridgeError {
  pluginId: string
  strategyId: string
  message: string
}

export interface RoutingStrategiesBridgeResult {
  registered: number
  errors: RoutingStrategiesBridgeError[]
}

export interface RoutingStrategiesBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}

const DEFAULT_IMPORTER: NonNullable<RoutingStrategiesBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

export async function registerRoutingStrategiesForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: RoutingStrategiesBridgeOptions = {}
): Promise<RoutingStrategiesBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.routingStrategies ?? []
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  // Clear prior on re-enable.
  unregisterRoutingStrategiesForPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const errors: RoutingStrategiesBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    try {
      await registerOne(def, pluginId, installRoot, importer)
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, strategyId: def.id, message })
      loggers.manager.error(
        `[routing-strategies-bridge] failed to register ${pluginId}:${def.id}`,
        err
      )
    }
  }

  return { registered, errors }
}

async function registerOne(
  def: PluginRoutingStrategyDef,
  pluginId: string,
  installRoot: string,
  importer: NonNullable<RoutingStrategiesBridgeOptions["importer"]>
): Promise<void> {
  const resolved = resolvePluginPath(installRoot, def.entry)
  const mod = await importer(resolved)
  const exported = mod[def.export]
  if (typeof exported !== "function") {
    throw new Error(`entry "${def.entry}" does not export a factory named "${def.export}"`)
  }
  const factory = exported as PluginRoutingStrategyFactory
  const strategyId = `${pluginId}:${def.id}`
  const selectorLike = await factory({ strategyId, pluginId })
  if (!selectorLike || typeof selectorLike.select !== "function") {
    throw new Error(`factory "${def.export}" did not return a { select } selector`)
  }

  const ok = registerRoutingStrategy(
    {
      id: strategyId,
      label: def.label,
      select: (entries, telemetry, ctx) => selectorLike.select(entries, telemetry, ctx),
    },
    { pluginId }
  )
  if (!ok) {
    // Unreachable through the namespaced id, but keep the signal honest.
    throw new Error(`strategy id "${strategyId}" collides with a built-in strategy`)
  }
}

export function unregisterRoutingStrategiesForPlugin(pluginId: string): void {
  unregisterRoutingStrategiesByPlugin(pluginId)
}
