/**
 * Plugin resilience layer — timeout / retry / circuit-breaker for plugin
 * invocation and loading. Composes reused primitives (connector circuit
 * breaker, `withTimeout`, `combineAbortSignals`, queue backoff) — see the
 * individual modules. This barrel is the public entry point.
 */

export {
  classifyResilienceError,
  isRetryableKind,
  type ResilienceErrorKind,
} from "./error-classify"
export {
  activationBreakerKey,
  breakerKey,
  getOrCreateBreaker,
  loadBreakerKey,
  resetPluginBreakers,
  snapshotAll,
  snapshotKey,
  __resetRegistryForTesting,
  type PluginBreakerConfig,
} from "./breaker-registry"
export { CircuitOpenError, runResilient, type RunResilientOptions } from "./run-resilient"
export {
  checkResilienceBudget,
  DEFAULT_PLUGIN_RESILIENCE,
  isRetryableLoadError,
  LOAD_RESILIENCE,
  resolveResilienceConfig,
  SIDECAR_IPC_TIMEOUT_MS,
  type ResolvedResilienceConfig,
} from "./config"
