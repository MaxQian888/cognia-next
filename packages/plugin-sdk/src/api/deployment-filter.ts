/**
 * Plugin SDK — `deployment-filter` capability surface.
 *
 * Exports the authoring helper and the provider-routing deployment-filter
 * overlay registry used by plugin-contributed pre-call filters. The host
 * registers manifest-declared filters itself.
 */

export { defineDeploymentFilter } from "../define/define-deployment-filter"

export type {
  DeploymentFiltersBridgeError,
  DeploymentFiltersBridgeOptions,
  DeploymentFiltersBridgeResult,
} from "@cognia/plugin-contract/lib/plugin/bridge/deployment-filters-bridge"

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
} from "@cognia/plugin-contract/types/plugin/plugin-deployment-filter"

export type {
  DeploymentCandidate,
  DeploymentFilter,
  FilterContext,
  FilterOutcome,
  FilterRequest,
} from "@cognia/provider-types/deployment-filter"
