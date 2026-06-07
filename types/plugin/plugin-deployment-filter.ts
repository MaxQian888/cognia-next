/**
 * Plugin-contributed pre-call deployment filters
 * (`manifest.deploymentFilters`) — the LiteLLM `optional_pre_call_checks`
 * analog, declared as ADR-0026 lazy-factory entries and registered into the
 * deployment-filter registry on plugin enable.
 *
 * The registered filter id is namespaced as `${pluginId}:${id}` so a plugin
 * can never shadow a built-in filter or another plugin's. Users opt the
 * filter into the chain via `RoutingConfig.filterChain` referencing that
 * full id.
 */

import type {
  DeploymentCandidate,
  FilterContext,
  FilterOutcome,
  FilterRequest,
} from "@/types/provider/deployment-filter"

/** One declarative deployment-filter contribution. */
export interface PluginDeploymentFilterDef {
  /** Filter id (namespaced to `${pluginId}:${id}` at registration). */
  id: string
  /** Human-readable label for the routing settings UI. */
  label: string
  description?: string
  /** Relative module path inside the plugin (lazy-imported on enable). */
  entry: string
  /** Export name of the factory function in `entry`. */
  export: string
}

/** What the factory must return: the pure filter core (must not throw). */
export interface PluginDeploymentFilterLike {
  filter: (
    candidates: readonly DeploymentCandidate[],
    req: FilterRequest,
    ctx: FilterContext
  ) => FilterOutcome
}

/** Factory context handed to the plugin's exported factory. */
export interface PluginDeploymentFilterContext {
  /** The namespaced id the filter registers under. */
  filterId: string
  pluginId: string
}

export type PluginDeploymentFilterFactory = (
  ctx: PluginDeploymentFilterContext
) => PluginDeploymentFilterLike | Promise<PluginDeploymentFilterLike>
