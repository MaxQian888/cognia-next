// Re-export shim: canonical source moved to @cognia/provider-routing (Stage 4).
export {
  DEFAULT_FILTER_CHAIN,
  __resetDeploymentFiltersForTesting,
  getDeploymentFilter,
  listDeploymentFilters,
  registerDeploymentFilter,
  unregisterDeploymentFilter,
  unregisterDeploymentFiltersByPlugin,
} from "@cognia/provider-routing/filter-registry"
