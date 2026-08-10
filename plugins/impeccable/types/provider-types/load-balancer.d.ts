import { ProviderName } from "./provider.js"
import "./built-in-provider-catalog.js"
import "./bedrock.js"

/**
 * Load Balancer type definitions
 * Settings and configuration for provider load balancing
 */

/**
 * Load balancing strategy types
 */
type LoadBalancingStrategy =
  "round-robin" | "weighted" | "least-connections" | "latency-based" | "adaptive" | "priority"
/**
 * Provider weight configuration for weighted strategy
 */
interface ProviderWeight {
  providerId: string
  weight: number
}
/**
 * Circuit breaker settings
 */
interface CircuitBreakerSettings {
  /** Enable circuit breaker */
  enabled: boolean
  /** Number of failures before opening the circuit */
  failureThreshold: number
  /** Time in ms before attempting to close an open circuit */
  resetTimeout: number
  /** Number of successful requests required to close a half-open circuit */
  successThreshold: number
}
/**
 * Load balancer settings stored in settings store
 */
interface LoadBalancerSettings {
  /** Enable load balancing */
  enabled: boolean
  /** Load balancing strategy */
  strategy: LoadBalancingStrategy
  /** Provider weights for weighted strategy */
  weights: ProviderWeight[]
  /** Enable sticky sessions (route same user to same provider) */
  stickySession: boolean
  /** Session TTL in ms (default: 5 minutes) */
  sessionTtl: number
  /** Fallback providers in order of preference */
  fallbackOrder: ProviderName[]
  /** Minimum success rate to consider provider healthy (0-1) */
  minSuccessRate: number
  /** Maximum latency to consider provider responsive (ms) */
  maxLatency: number
  /** Circuit breaker settings */
  circuitBreaker: CircuitBreakerSettings
  /** Enable automatic failover to next provider on failure */
  autoFailover: boolean
  /** Maximum retry attempts for failover */
  maxRetries: number
}
/**
 * Default load balancer settings
 */
declare const DEFAULT_LOAD_BALANCER_SETTINGS: LoadBalancerSettings
/**
 * Provider metrics for load balancing decisions
 */
interface ProviderLoadMetrics {
  providerId: string
  activeConnections: number
  totalRequests: number
  totalErrors: number
  averageLatency: number
  lastLatency: number
  lastRequestTime: number
  successRate: number
  isHealthy: boolean
  isAvailable: boolean
}
/**
 * Load balancer state for monitoring
 */
interface LoadBalancerState {
  /** Current strategy in use */
  activeStrategy: LoadBalancingStrategy
  /** Provider metrics */
  metrics: Record<string, ProviderLoadMetrics>
  /** Currently selected provider */
  currentProvider: string | null
  /** Alternative providers available */
  alternatives: string[]
  /** Circuit breaker states */
  circuitStates: Record<string, "closed" | "open" | "half_open">
  /** Last selection timestamp */
  lastSelection: number
}

export {
  type CircuitBreakerSettings,
  DEFAULT_LOAD_BALANCER_SETTINGS,
  type LoadBalancerSettings,
  type LoadBalancerState,
  type LoadBalancingStrategy,
  type ProviderLoadMetrics,
  type ProviderWeight,
}
