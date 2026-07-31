/**
 * Deployment-filter registry: static built-ins ⊕ a dynamic overlay for
 * plugin-registered custom filters (LiteLLM `optional_pre_call_checks`
 * analog). Built-ins are consulted FIRST and can never be shadowed — a
 * plugin overriding "circuit" would silently disable breaker routing for
 * every user.
 *
 * Same `static ⊕ overlay` composition as `strategy-registry.ts`.
 */

import { createOverlayRegistry } from "./overlay-registry"
import type { DeploymentFilter } from "@cognia/provider-types/deployment-filter"
import { affinityFilter } from "./filters/affinity"
import { BUILT_IN_DEPLOYMENT_FILTERS } from "./filters/built-in"

const ALL_BUILT_INS: ReadonlyArray<DeploymentFilter> = [
  affinityFilter,
  ...BUILT_IN_DEPLOYMENT_FILTERS,
]

const builtIns = new Map<string, DeploymentFilter>(ALL_BUILT_INS.map((f) => [f.id, f]))

/**
 * The chain the engine runs when `RoutingConfig.filterChain` is unset —
 * exactly the historical inline order, with affinity (a no-op without a
 * sessionId/pin) in front.
 */
export const DEFAULT_FILTER_CHAIN: ReadonlyArray<string> = [
  "affinity",
  "circuit",
  "context-window",
  "rate-limit",
  "budget",
]

const overlay = createOverlayRegistry<DeploymentFilter>({
  name: "deployment-filters",
  conflictPolicy: "first-wins-cross-plugin",
})

/** Resolve a filter by id — built-ins first, then the dynamic overlay. */
export function getDeploymentFilter(id: string): DeploymentFilter | undefined {
  return builtIns.get(id) ?? overlay.get(id)
}

/**
 * Register a custom filter. Built-in ids are rejected (returns false) so the
 * historical checks stay authoritative.
 */
export function registerDeploymentFilter(
  filter: DeploymentFilter,
  opts?: { pluginId?: string }
): boolean {
  if (builtIns.has(filter.id)) {
    return false
  }
  overlay.register(filter.id, filter, opts)
  return true
}

export function unregisterDeploymentFilter(id: string): boolean {
  return overlay.unregisterById(id)
}

export function unregisterDeploymentFiltersByPlugin(pluginId: string): number {
  return overlay.unregisterByPlugin(pluginId)
}

/** Every known filter id (built-ins first, then customs) for the settings UI. */
export function listDeploymentFilters(): Array<{
  id: string
  label: string
  builtIn: boolean
  pluginId?: string
}> {
  const customs = overlay.entries().map(({ id, entry, pluginId }) => ({
    id,
    label: entry.label ?? id,
    builtIn: false,
    pluginId,
  }))
  const statics = ALL_BUILT_INS.map((f) => ({
    id: f.id,
    label: f.label ?? f.id,
    builtIn: true,
  }))
  return [...statics, ...customs]
}

/** Test-only: drop every custom filter. */
export function __resetDeploymentFiltersForTesting(): void {
  overlay.__resetForTesting()
}
