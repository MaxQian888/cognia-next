/**
 * Plugin SDK — `deployment-filter` capability surface.
 *
 * Re-exports the authoring helper, manifest bridge, and provider-routing
 * deployment-filter overlay registry used by plugin-contributed pre-call
 * filters.
 */

export { defineDeploymentFilter } from "../define/define-deployment-filter"

export {
  registerDeploymentFiltersForPlugin,
  unregisterDeploymentFiltersForPlugin,
} from "@/lib/plugin/bridge/deployment-filters-bridge"

export type {
  DeploymentFiltersBridgeError,
  DeploymentFiltersBridgeOptions,
  DeploymentFiltersBridgeResult,
} from "@/lib/plugin/bridge/deployment-filters-bridge"

export {
  DEFAULT_FILTER_CHAIN,
  getDeploymentFilter,
  listDeploymentFilters,
  registerDeploymentFilter,
  unregisterDeploymentFilter,
  unregisterDeploymentFiltersByPlugin,
} from "@cognia/provider-routing/filter-registry"

export type {
  PluginDeploymentFilterContext,
  PluginDeploymentFilterDef,
  PluginDeploymentFilterFactory,
  PluginDeploymentFilterLike,
} from "@/types/plugin/plugin-deployment-filter"

export type {
  DeploymentCandidate,
  DeploymentFilter,
  FilterContext,
  FilterOutcome,
  FilterRequest,
} from "@cognia/provider-types/deployment-filter"
