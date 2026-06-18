/**
 * Auto Router type definitions
 * Intelligent model selection based on task complexity and requirements
 */

import type { ProviderName } from "./provider"
// Type-only cross-domain reference to the shared agent-mode union. Erased at
// runtime (JS output has zero coupling); resolved via the `@/*` path alias in
// app typecheck, jest, and this package's tsconfig (`@/* → ../../*`). Kept as a
// single source of truth rather than duplicated to avoid drift.
import type { AgentModeType } from "@/types/agent/agent-mode"

// Routing mode - how the router decides which model to use
export type RoutingMode = "rule-based" | "llm-based" | "hybrid"

// Routing strategy - what to optimize for
export type RoutingStrategy =
  | "quality" // Always use the best model available
  | "cost" // Minimize cost while maintaining quality
  | "speed" // Prioritize fast response times
  | "balanced" // Balance between quality, cost, and speed
  | "adaptive" // Learn from user feedback

// Model tier for routing decisions
export type ModelTier = "fast" | "balanced" | "powerful" | "reasoning"

// Task complexity levels
export type TaskComplexity = "simple" | "moderate" | "complex" | "expert"

// Task categories for specialized routing
export type TaskCategory =
  | "general"
  | "coding"
  | "analysis"
  | "creative"
  | "research"
  | "conversation"
  | "math"
  | "translation"
  | "summarization"

// Model capabilities for filtering
export interface ModelCapabilities {
  supportsVision: boolean
  supportsTools: boolean
  supportsStreaming: boolean
  supportsReasoning: boolean
  contextLength: number
  maxOutputTokens?: number
}

// Task classification result
export interface TaskClassification {
  complexity: TaskComplexity
  category: TaskCategory
  requiresReasoning: boolean
  requiresTools: boolean
  requiresVision: boolean
  requiresCreativity: boolean
  requiresCoding: boolean
  requiresLongContext: boolean
  estimatedInputTokens: number
  estimatedOutputTokens: number
  confidence: number // 0-1, how confident the classifier is
  agentModeHint?: AgentModeType // Suggested agent mode if applicable
}

// Model selection result
export interface ModelSelection {
  provider: ProviderName
  model: string
  tier: ModelTier
  reason: string
  routingMode: RoutingMode
  routingLatency: number
  classification: TaskClassification
  alternatives?: Array<{
    provider: ProviderName
    model: string
    reason: string
  }>
  estimatedCost?: {
    inputCost: number
    outputCost: number
    totalCost: number
  }
}

// Router model configuration for LLM-based routing
export interface RouterModelConfig {
  provider: ProviderName
  model: string
  priority: number // Lower = higher priority
}

// Model tier configuration
export interface TierModelEntry {
  provider: ProviderName
  model: string
  priority?: number
  capabilities?: Partial<ModelCapabilities>
}

// Auto router settings stored in settings store
export interface AutoRouterSettings {
  // Enable/disable auto routing
  enabled: boolean

  // Routing mode preference
  routingMode: RoutingMode

  // Routing strategy
  strategy: RoutingStrategy

  // Show routing decisions in UI
  showRoutingIndicator: boolean

  // Allow user to override routing decisions
  allowOverride: boolean

  // Preferred providers (priority order)
  preferredProviders: ProviderName[]

  // Excluded providers (never use)
  excludedProviders: ProviderName[]

  // Cost limit per request (in USD cents)
  maxCostPerRequest?: number

  // Custom tier overrides
  customTierModels?: {
    fast?: TierModelEntry[]
    balanced?: TierModelEntry[]
    powerful?: TierModelEntry[]
    reasoning?: TierModelEntry[]
  }

  // Router model for LLM-based routing
  routerModel?: RouterModelConfig

  // Cache routing decisions
  enableCache: boolean
  cacheTTL: number // seconds

  // Fallback behavior
  fallbackTier: ModelTier
  fallbackProvider?: ProviderName
}

// Default auto router settings
export const DEFAULT_AUTO_ROUTER_SETTINGS: AutoRouterSettings = {
  enabled: true,
  routingMode: "rule-based",
  strategy: "balanced",
  showRoutingIndicator: true,
  allowOverride: true,
  preferredProviders: [],
  excludedProviders: [],
  maxCostPerRequest: undefined,
  customTierModels: undefined,
  routerModel: undefined,
  enableCache: true,
  cacheTTL: 300, // 5 minutes
  fallbackTier: "balanced",
  fallbackProvider: undefined,
}

// Routing decision cache entry
export interface RoutingCacheEntry {
  key: string
  selection: ModelSelection
  timestamp: number
  hitCount: number
}

// Routing statistics
export interface RoutingStats {
  totalRequests: number
  byTier: Record<ModelTier, number>
  byProvider: Record<string, number>
  byCategory: Record<TaskCategory, number>
  avgLatency: number
  cacheHitRate: number
  estimatedCostSaved: number
}

// Context for routing decisions
export interface RoutingContext {
  // Current session context
  sessionId?: string
  messageCount?: number
  previousModels?: string[]

  // Agent mode context
  agentMode?: AgentModeType
  agentTools?: string[]

  // Attachment context
  hasImages?: boolean
  hasDocuments?: boolean
  hasCode?: boolean

  // User preferences
  userPreferredProvider?: ProviderName
  userPreferredTier?: ModelTier

  // Performance hints
  preferFastResponse?: boolean
  preferHighQuality?: boolean

  // Skill context for skill-aware routing
  activeSkillCategories?: string[]
  activeSkillCount?: number
}

// Per-request routing override options
export interface RequestRoutingOverride {
  /** Override the global routing strategy for this request */
  strategy?: RoutingStrategy
  /** Use a specific model alias instead of direct provider:model */
  modelAlias?: string
  /** Force a specific provider (bypasses routing) */
  forceProvider?: ProviderName
  /** Force a specific model (bypasses routing) */
  forceModel?: string
  /** Timeout override in ms for this request */
  timeoutMs?: number
}

// Routing event for analytics
export interface RoutingEvent {
  timestamp: number
  input: string
  classification: TaskClassification
  selection: ModelSelection
  context?: RoutingContext
  userOverride?: {
    provider: ProviderName
    model: string
    reason?: string
  }
  feedback?: {
    satisfied: boolean
    comment?: string
  }
}
