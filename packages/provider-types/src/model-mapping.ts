/**
 * Model Mapping type definitions
 * User-configurable alias-to-provider:model mappings with fallback chains
 */

import type { RoutingStrategy } from "./auto-router"
import type { CircuitBreakerConfig } from "./circuit-breaker"
import type { ProviderErrorClass } from "./error-class"

/**
 * Persisted global circuit-breaker settings (AppSettings.routingConfig).
 * Hydrated into the in-memory breaker store on every send so reliability
 * routing survives reloads. Absent → the breaker stays opt-in-off
 * (historical behavior).
 */
export interface RoutingCircuitBreakerSettings extends Partial<CircuitBreakerConfig> {
  enabled: boolean
}

/** A single entry in a model mapping's fallback chain */
export interface ModelMappingEntry {
  /** Provider ID (e.g., 'openai', 'groq', 'deepseek') */
  providerId: string
  /** Model ID within the provider (e.g., 'gpt-4o', 'llama-3.3-70b') */
  modelId: string
  /** Weight for weighted distribution (0-100). Only used when distribution is 'weighted'. */
  weight?: number
  /** Conditions that must be met for this entry to be eligible */
  conditions?: ModelMappingConditions
}

/** Conditions for activating/filtering a mapping entry */
export interface ModelMappingConditions {
  /** Maximum cost per 1M tokens (USD) — skip this entry if pricing exceeds */
  maxCostPer1M?: number
  /** Maximum latency in ms — skip this entry if recent P50 exceeds */
  maxLatencyMs?: number
}

/** Default generation parameters that apply when using an alias */
export interface ModelMappingParameterDefaults {
  temperature?: number
  maxTokens?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
}

/** Distribution strategy for entries in a mapping */
export type MappingDistributionStrategy = "priority" | "weighted"

/**
 * Error-class-specific fallback chains (LiteLLM `context_window_fallbacks` /
 * `content_policy_fallbacks` analog). When a turn fails with one of these
 * classes the retry path routes through the dedicated chain instead of the
 * main one — a same-sized model fails a context-window error the same way,
 * so the dedicated chain points at larger-window / alternate-provider
 * entries.
 */
export interface ModelMappingSpecialFallbacks {
  /** Tried when the failure classifies as `context-window-exceeded`. */
  contextWindowExceeded?: ModelMappingEntry[]
  /** Tried when the failure classifies as `content-policy`. */
  contentPolicy?: ModelMappingEntry[]
}

/**
 * Per-error-class retry budget for the MAIN fallback chain. Absent classes
 * keep the historical behavior (retry transient classes through the whole
 * chain). `maxRetries: 0` disables retries for that class entirely.
 */
export type ModelMappingRetryPolicy = Partial<Record<ProviderErrorClass, { maxRetries: number }>>

/** A complete model mapping: alias → provider:model chain */
export interface ModelMapping {
  /** Unique identifier */
  id: string
  /** Logical alias name (e.g., 'fast', 'coding', 'reasoning') */
  alias: string
  /** Ordered provider:model entries (fallback chain or weighted pool) */
  providers: ModelMappingEntry[]
  /** How entries are selected: 'priority' (first available) or 'weighted' (random by weight) */
  distribution: MappingDistributionStrategy
  /** Default generation parameters applied when this alias is used */
  parameterDefaults?: ModelMappingParameterDefaults
  /** Error-class-specific fallback chains (context-window / content-policy). */
  specialFallbacks?: ModelMappingSpecialFallbacks
  /** Per-error-class retry budgets for the main chain. */
  retryPolicy?: ModelMappingRetryPolicy
  /** Whether this mapping is enabled */
  enabled: boolean
  /** Whether this is a system-generated default mapping (vs user-created) */
  isDefault?: boolean
  /** Creation timestamp */
  createdAt: number
  /** Last modified timestamp */
  updatedAt: number
}

/** The full model mapping registry state */
export interface ModelMappingRegistry {
  /** All model mappings keyed by alias */
  mappings: ModelMapping[]
  /** Whether the mapping system is enabled globally */
  enabled: boolean
}

/** Default registry state */
export const DEFAULT_MODEL_MAPPING_REGISTRY: ModelMappingRegistry = {
  mappings: [],
  enabled: true,
}

/** Result of resolving a model alias */
export interface AliasResolutionResult {
  /** Whether an alias was found */
  found: boolean
  /** The resolved provider:model entries in priority order (filtered by conditions and circuit breaker) */
  entries: ModelMappingEntry[]
  /** The original mapping if found */
  mapping?: ModelMapping
  /** Parameter defaults from the mapping */
  parameterDefaults?: ModelMappingParameterDefaults
}

/** Per-provider constraint for routing */
export interface ProviderConstraint {
  providerId: string
  /** Maximum requests per minute (rate limit) */
  maxRequestsPerMinute?: number
  /** Maximum tokens per minute (rate limit) */
  maxTokensPerMinute?: number
  /** Daily cost budget in USD */
  dailyCostBudget?: number
  /** Priority level (lower = higher priority) */
  priority?: number
  /**
   * Per-provider circuit-breaker override (allowed_fails / cooldown_time
   * analog) merged onto the global breaker defaults for this provider.
   */
  circuitConfig?: Partial<CircuitBreakerConfig>
  /** Whether this constraint is active */
  enabled: boolean
}

/** Routing configuration combining strategy, mappings, and constraints */
export interface RoutingConfig {
  /** Active routing strategy */
  strategy: RoutingStrategy
  /** Per-request strategy override allowed */
  allowPerRequestOverride: boolean
  /** Per-provider constraints */
  providerConstraints: ProviderConstraint[]
  /** Request timeout in ms before triggering fallback */
  requestTimeoutMs: number
  /** Maximum fallback attempts */
  maxFallbackAttempts: number
  /** Time budget for one asynchronous plugin selector or filter. */
  pluginTimeoutMs?: number
  /**
   * Ordered pre-call filter chain (built-in + plugin filter ids) the engine
   * runs before strategy selection. Undefined (default) keeps the built-in
   * `DEFAULT_FILTER_CHAIN`; unknown ids are skipped.
   */
  filterChain?: string[]
  /**
   * Persisted global circuit-breaker settings, hydrated into the in-memory
   * breaker store on every send. Undefined keeps the breaker opt-in-off.
   */
  circuitBreaker?: RoutingCircuitBreakerSettings
}

/** Default routing config */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  strategy: "reliability",
  allowPerRequestOverride: true,
  providerConstraints: [],
  requestTimeoutMs: 30000,
  maxFallbackAttempts: 3,
  pluginTimeoutMs: 250,
  // Reliability default: the breaker ships ENABLED with conservative
  // thresholds so a flapping provider is routed around and auto-recovers. A
  // 50% failure-rate trip needs ≥10 requests in the 60s window, so it never
  // fires on a cold start or a single transient blip. Users who explicitly
  // persisted a routingConfig WITHOUT a circuitBreaker block keep their
  // historical opt-in-off behavior (this default applies only when no
  // routingConfig is persisted at all).
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,
    windowDurationMs: 60000,
    cooldownMs: 30000,
    successThreshold: 1,
    failureRateThreshold: 0.5,
    minRequestVolume: 10,
  },
}
