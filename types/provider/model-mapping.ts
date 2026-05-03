/**
 * Model Mapping type definitions
 * User-configurable alias-to-provider:model mappings with fallback chains
 */

import type { RoutingStrategy } from "./auto-router"

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
  /** Daily cost budget in USD */
  dailyCostBudget?: number
  /** Priority level (lower = higher priority) */
  priority?: number
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
}

/** Default routing config */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  strategy: "balanced",
  allowPerRequestOverride: true,
  providerConstraints: [],
  requestTimeoutMs: 30000,
  maxFallbackAttempts: 3,
}
