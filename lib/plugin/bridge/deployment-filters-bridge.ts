/**
 * Deployment Filters Bridge.
 *
 * Resolves `manifest.deploymentFilters` contributions on plugin enable
 * (synthetic module-bridge key — field-driven, no capability tag, same
 * posture as `routing-strategy`). Each entry is an ADR-0026 lazy
 * factory `{ id, label, entry, export }`: the bridge dynamic-imports the
 * entry, calls the factory, and registers the returned filter into the
 * deployment-filter registry under the namespaced id
 * `${pluginId}:${def.id}`.
 *
 * Safety: the registry refuses built-in ids, the chain runner try-catches
 * every filter call (a throwing custom filter is skipped), users opt the
 * filter into the chain explicitly via `RoutingConfig.filterChain`, and
 * disable drops all of a plugin's filters in one call.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  PluginDeploymentFilterDef,
  PluginDeploymentFilterFactory,
} from "@/types/plugin/plugin-deployment-filter"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  createPythonBackedProxy,
  isPythonBackedContribution,
} from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import {
  registerDeploymentFilter,
  unregisterDeploymentFiltersByPlugin,
} from "@cognia/provider-routing/filter-registry"

export interface DeploymentFiltersBridgeError {
  pluginId: string
  filterId: string
  message: string
}

export interface DeploymentFiltersBridgeResult {
  registered: number
  errors: DeploymentFiltersBridgeError[]
}

export interface DeploymentFiltersBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}

const DEFAULT_IMPORTER: NonNullable<DeploymentFiltersBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

export async function registerDeploymentFiltersForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: DeploymentFiltersBridgeOptions = {}
): Promise<DeploymentFiltersBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.deploymentFilters ?? []
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  // Clear prior on re-enable.
  unregisterDeploymentFiltersForPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const errors: DeploymentFiltersBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    try {
      await registerOne(def, pluginId, manifest.type, installRoot, importer)
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, filterId: def.id, message })
      loggers.manager.error(
        `[deployment-filters-bridge] failed to register ${pluginId}:${def.id}`,
        err
      )
    }
  }

  return { registered, errors }
}

async function registerOne(
  def: PluginDeploymentFilterDef,
  pluginId: string,
  pluginType: string | undefined,
  installRoot: string,
  importer: NonNullable<DeploymentFiltersBridgeOptions["importer"]>
): Promise<void> {
  const filterId = `${pluginId}:${def.id}`
  const pythonBacked = isPythonBackedContribution(def, pluginType)
  const filterLike = pythonBacked
    ? createPythonBackedProxy<Awaited<ReturnType<PluginDeploymentFilterFactory>>>({
        pluginId,
        contributionId: def.id,
        methods: ["filter"],
        label: "deployment filter",
      })
    : await resolveJsFilter(def, pluginId, filterId, installRoot, importer)

  const ok = registerDeploymentFilter(
    {
      id: filterId,
      label: def.label,
      // Legacy synchronous routing cannot enter the Python subprocess, so it
      // keeps the current candidates. planRoute uses filterAsync below.
      filter: (candidates, req, ctx) =>
        pythonBacked ? { candidates: [...candidates] } : filterLike.filter(candidates, req, ctx),
      ...(pythonBacked
        ? {
            filterAsync: (candidates, req, ctx) =>
              Promise.resolve(filterLike.filter(candidates, req, ctx)),
          }
        : filterLike.filterAsync
          ? {
              filterAsync: (candidates, req, ctx) => filterLike.filterAsync!(candidates, req, ctx),
            }
          : {}),
    },
    { pluginId }
  )
  if (!ok) {
    // Unreachable through the namespaced id, but keep the signal honest.
    throw new Error(`filter id "${filterId}" collides with a built-in filter`)
  }
}

async function resolveJsFilter(
  def: PluginDeploymentFilterDef,
  pluginId: string,
  filterId: string,
  installRoot: string,
  importer: NonNullable<DeploymentFiltersBridgeOptions["importer"]>
): Promise<Awaited<ReturnType<PluginDeploymentFilterFactory>>> {
  if (!def.entry || !def.export) {
    throw new Error(
      `JS-backed deployment filter "${def.id}" must declare both "entry" and "export"` +
        ` (set backend: "python" to run it in the plugin's Python subprocess)`
    )
  }
  const resolved = resolvePluginPath(installRoot, def.entry)
  const mod = await importer(resolved)
  const exported = mod[def.export]
  if (typeof exported !== "function") {
    throw new Error(`entry "${def.entry}" does not export a factory named "${def.export}"`)
  }
  const factory = exported as PluginDeploymentFilterFactory
  const filterLike = await factory({ filterId, pluginId })
  if (!filterLike || typeof filterLike.filter !== "function") {
    throw new Error(`factory "${def.export}" did not return a { filter } deployment filter`)
  }
  return filterLike
}

export function unregisterDeploymentFiltersForPlugin(pluginId: string): void {
  unregisterDeploymentFiltersByPlugin(pluginId)
}
