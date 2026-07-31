/**
 * Circuit Breaker type definitions
 * Per-deployment circuit breaker state machine for failure prevention
 * (`providerId::modelId[::keyId]` keys — see `types/provider/deployment.ts`),
 * with provider-level reads reduced across deployments for back-compat.
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
  /**
   * Failure-RATE trip (LiteLLM failure-percent analog): open when
   * `failures / requests` within the window reaches this ratio (0-1) AND the
   * window saw at least `minRequestVolume` requests. Undefined (default)
   * keeps the historical absolute-count-only behavior byte-identical.
   */
  failureRateThreshold?: number
  /** Minimum window request volume before the rate trip applies (default 10). */
  minRequestVolume?: number
  /**
   * Upper clamp for Retry-After-derived dynamic cooldowns, guarding against
   * hostile/garbage header values. Default 10 minutes.
   */
  maxCooldownMs?: number
}

/** Default circuit breaker configuration */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  windowDurationMs: 60000, // 60 seconds
  cooldownMs: 30000, // 30 seconds
  successThreshold: 1,
}

/** Default `minRequestVolume` when failure-rate mode is configured without one. */
export const DEFAULT_MIN_REQUEST_VOLUME = 10

/** Default upper clamp for Retry-After-derived cooldowns. */
export const DEFAULT_MAX_COOLDOWN_MS = 600_000

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
  /** Rolling request volume in the current window (failure-rate mode only). */
  windowRequestCount?: number
  /** Start of the current counting window (failure-rate mode only). */
  windowStartAt?: number | null
  /**
   * Cooldown override derived from a Retry-After hint on the failure that
   * opened the circuit (clamped by `maxCooldownMs`). Cleared on close.
   */
  dynamicCooldownMs?: number
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

/** A single deployment's circuit breaker with config and state */
export interface ProviderCircuitBreaker {
  providerId: string
  /** Store key (`providerId::modelId[::keyId]`) this breaker tracks. */
  deploymentKey: string
  config: CircuitBreakerConfig
  state: CircuitBreakerState
}

/** Deployment targeting for success records. */
export interface CircuitBreakerRecordOptions {
  /** Model the turn ran against. Absent → provider wildcard bucket. */
  modelId?: string
  /** Credential id (multi-key rotation granularity). */
  keyId?: string
}

/** Deployment targeting + retry hint for failure records. */
export interface CircuitBreakerFailureOptions extends CircuitBreakerRecordOptions {
  /** Retry-After hint (ms) extracted from the provider error, if any. */
  retryAfterMs?: number
}

/** Circuit breaker store state (non-persisted, in-memory only) */
export interface CircuitBreakerStoreState {
  /** Circuit breakers keyed by deployment key (`providerId::modelId[::keyId]`) */
  breakers: Record<string, ProviderCircuitBreaker>
  /** Per-provider config overrides applied to all (incl. future) deployments */
  providerConfigs: Record<string, Partial<CircuitBreakerConfig>>
  /**
   * Provider-level read, reduced across the provider's deployments: best
   * state wins (closed > half-open > open) so one tripped model does not
   * blackhole the whole provider.
   */
  getState: (providerId: string) => CircuitBreakerStateValue
  /** State for one deployment (`closed` when untracked). */
  getDeploymentState: (deploymentKey: string) => CircuitBreakerStateValue
  /** Check if a provider is available (any deployment not open) */
  isAvailable: (providerId: string) => boolean
  /** Check if a single deployment is available (circuit not open) */
  isDeploymentAvailable: (deploymentKey: string) => boolean
  /** Record a successful request */
  recordSuccess: (providerId: string, opts?: CircuitBreakerRecordOptions) => void
  /** Record a failed request */
  recordFailure: (providerId: string, opts?: CircuitBreakerFailureOptions) => void
  /** Reset all of a provider's deployment breakers to closed */
  resetBreaker: (providerId: string) => void
  /** Reset all circuit breakers */
  resetAll: () => void
  /** Update config for a provider (applies to all its deployments) */
  updateConfig: (providerId: string, config: Partial<CircuitBreakerConfig>) => void
}
