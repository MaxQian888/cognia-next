/**
 * Circuit Breaker type definitions
 * Per-provider circuit breaker state machine for failure prevention
 */

/** Circuit breaker states */
export type CircuitBreakerStateValue = "closed" | "open" | "half-open"

/** Configuration for a circuit breaker instance */
export interface CircuitBreakerConfig {
  /** Number of failures within the window to trigger opening */
  failureThreshold: number
  /** Sliding window duration in ms */
  windowDurationMs: number
  /** Cooldown duration in ms before transitioning from open → half-open */
  cooldownMs: number
  /** Number of successful probes required to close (from half-open) */
  successThreshold: number
}

/** Default circuit breaker configuration */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  windowDurationMs: 60000, // 60 seconds
  cooldownMs: 30000, // 30 seconds
  successThreshold: 1,
}

/** Runtime state of a single circuit breaker instance */
export interface CircuitBreakerState {
  /** Current state of the circuit */
  state: CircuitBreakerStateValue
  /** Number of failures in the current window */
  failureCount: number
  /** Number of successful probes in half-open state */
  successCount: number
  /** Timestamp of the last failure */
  lastFailureAt: number | null
  /** Timestamp when the circuit was opened */
  openedAt: number | null
  /** Timestamp of the last state transition */
  lastTransitionAt: number
  /** Total number of requests blocked while open */
  blockedCount: number
}

/** Initial state for a new circuit breaker */
export const INITIAL_CIRCUIT_BREAKER_STATE: CircuitBreakerState = {
  state: "closed",
  failureCount: 0,
  successCount: 0,
  lastFailureAt: null,
  openedAt: null,
  lastTransitionAt: Date.now(),
  blockedCount: 0,
}

/** Per-provider circuit breaker with config and state */
export interface ProviderCircuitBreaker {
  providerId: string
  config: CircuitBreakerConfig
  state: CircuitBreakerState
}

/** Circuit breaker store state (non-persisted, in-memory only) */
export interface CircuitBreakerStoreState {
  /** Circuit breakers keyed by provider ID */
  breakers: Record<string, ProviderCircuitBreaker>
  /** Get the state for a specific provider */
  getState: (providerId: string) => CircuitBreakerStateValue
  /** Check if a provider is available (circuit not open) */
  isAvailable: (providerId: string) => boolean
  /** Record a successful request */
  recordSuccess: (providerId: string) => void
  /** Record a failed request */
  recordFailure: (providerId: string) => void
  /** Reset a provider's circuit breaker to closed */
  resetBreaker: (providerId: string) => void
  /** Reset all circuit breakers */
  resetAll: () => void
  /** Update config for a specific provider */
  updateConfig: (providerId: string, config: Partial<CircuitBreakerConfig>) => void
}
