/**
 * Load Balancer type definitions
 * Settings and configuration for provider load balancing
 */

import type { ProviderName } from "./provider"

/**
 * Load balancing strategy types
 */
export type LoadBalancingStrategy =
  | "round-robin" // Cycles through providers in order
  | "weighted" // Distributes based on provider weights
  | "least-connections" // Routes to provider with fewest active requests
  | "latency-based" // Routes to fastest responding provider
  | "adaptive" // Combines multiple factors for optimal routing
  | "priority" // Follows configured priority order with fallback

/**
 * Provider weight configuration for weighted strategy
 */
export interface ProviderWeight {
  providerId: string
  weight: number // 0-100, higher = more traffic
}

/**
 * Circuit breaker settings
 */
export interface CircuitBreakerSettings {
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
export interface LoadBalancerSettings {
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
export const DEFAULT_LOAD_BALANCER_SETTINGS: LoadBalancerSettings = {
  enabled: true,
  strategy: "adaptive",
  weights: [],
  stickySession: false,
  sessionTtl: 300000, // 5 minutes
  fallbackOrder: [],
  minSuccessRate: 0.9,
  maxLatency: 5000,
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,
    resetTimeout: 30000,
    successThreshold: 3,
  },
  autoFailover: true,
  maxRetries: 3,
}

/**
 * Provider metrics for load balancing decisions
 */
export interface ProviderLoadMetrics {
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
export interface LoadBalancerState {
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
