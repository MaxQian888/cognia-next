/**
 * Provider Routing barrel
 *
 * Re-exports the public surface of the routing engine:
 *  - alias resolution + condition filtering
 *  - the engine that picks a single provider:model from a strategy
 *  - the fallback executor that drives the chain
 *  - default tier mappings (fast/balanced/powerful/reasoning)
 *  - in-memory registry helpers wrapping persisted ModelMapping[]
 *  - built-in routing presets (Budget / Performance / Reliability)
 */

export { resolveModelAlias, pickTopEntry, type ProviderHealthMetricsLite } from "./alias-resolver"

export {
  ProviderRoutingEngine,
  RoutingNoCandidatesError,
  type ProviderRoutingInfo,
  type RoutingEngineDeps,
  type RoutingResult,
} from "./provider-routing-engine"

export {
  generateDefaultMappings,
  getTierDisplayName,
  getDefaultTierAliases,
} from "./default-mappings"

export {
  createMappingRegistry,
  findMappingByAlias,
  listAliases,
  addMapping,
  removeMapping,
  updateMapping,
} from "./model-mapping-registry"

export {
  BUDGET_PRESET,
  PERFORMANCE_PRESET,
  RELIABILITY_PRESET,
  BUILT_IN_PRESETS,
  getBuiltInPreset,
  adaptPresetToEnabledProviders,
} from "./built-in-presets"

export {
  classifyProviderError,
  classifyProviderErrorInfo,
  extractRetryAfterMs,
  isTransientErrorClass,
  type ProviderErrorClass,
  type ProviderErrorInfo,
} from "./error-classifier"

export {
  getRoutingStrategy,
  registerRoutingStrategy,
  unregisterRoutingStrategy,
  unregisterRoutingStrategiesByPlugin,
  listRoutingStrategies,
} from "./strategy-registry"

export {
  DEFAULT_FILTER_CHAIN,
  getDeploymentFilter,
  registerDeploymentFilter,
  unregisterDeploymentFilter,
  unregisterDeploymentFiltersByPlugin,
  listDeploymentFilters,
} from "./filter-registry"

export { runFilterChain } from "./run-filter-chain"
export { RoutingAttemptController } from "./routing-attempt-controller"

export {
  circuitFilter,
  contextWindowFilter,
  rateLimitFilter,
  budgetFilter,
  BUILT_IN_DEPLOYMENT_FILTERS,
} from "./filters/built-in"

export { affinityFilter } from "./filters/affinity"

export {
  pinSessionDeployment,
  getSessionDeployment,
  releaseSessionDeployment,
  DEFAULT_AFFINITY_TTL_MS,
} from "./session-affinity-store"

export {
  scoreDifficulty,
  createDifficultySelector,
  ensureDifficultyStrategyRegistered,
} from "./difficulty-router"

export { pruneToolsSemantica, DEFAULT_SEMANTIC_EMBEDDING } from "./semantic-tool-router"

export {
  BUILT_IN_ROUTING_SELECTORS,
  reliabilitySelector,
  makeTelemetrySnapshot,
  qualitySelector,
  costSelector,
  speedSelector,
  balancedSelector,
  adaptiveSelector,
  leastBusySelector,
} from "./strategies/built-in"
