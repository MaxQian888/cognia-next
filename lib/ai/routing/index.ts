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
  type ProviderRoutingInfo,
  type RoutingEngineDeps,
  type RoutingResult,
} from "./provider-routing-engine"

export {
  executeFallbackChain,
  type FallbackConfig,
  type FallbackExecutorDeps,
  type ProviderAttemptResult,
} from "./fallback-executor"

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
  isTransientErrorClass,
  type ProviderErrorClass,
} from "./error-classifier"

export {
  getRoutingStrategy,
  registerRoutingStrategy,
  unregisterRoutingStrategy,
  unregisterRoutingStrategiesByPlugin,
  listRoutingStrategies,
} from "./strategy-registry"

export {
  scoreDifficulty,
  createDifficultySelector,
  ensureDifficultyStrategyRegistered,
} from "./difficulty-router"

export { pruneToolsSemantica, DEFAULT_SEMANTIC_EMBEDDING } from "./semantic-tool-router"

export {
  BUILT_IN_ROUTING_SELECTORS,
  makeTelemetrySnapshot,
  qualitySelector,
  costSelector,
  speedSelector,
  balancedSelector,
  adaptiveSelector,
  leastBusySelector,
} from "./strategies/built-in"
