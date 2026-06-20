// Re-export shim: canonical source moved to @cognia/provider-types (Stage 1).
export {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_MAX_COOLDOWN_MS,
  DEFAULT_MIN_REQUEST_VOLUME,
  INITIAL_CIRCUIT_BREAKER_STATE,
} from "@cognia/provider-types/circuit-breaker"
export type {
  CircuitBreakerConfig,
  CircuitBreakerFailureOptions,
  CircuitBreakerRecordOptions,
  CircuitBreakerState,
  CircuitBreakerStateValue,
  CircuitBreakerStoreState,
  ProviderCircuitBreaker,
} from "@cognia/provider-types/circuit-breaker"
