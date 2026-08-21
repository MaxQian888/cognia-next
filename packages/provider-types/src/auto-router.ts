/**
 * Auto Router type definitions
 * Intelligent model selection based on task complexity and requirements
 */

import type { ProviderName } from "./provider"
import type {
  ModelMappingEntry,
  ModelMappingParameterDefaults,
  ModelMappingRetryPolicy,
  ModelMappingSpecialFallbacks,
} from "./model-mapping"
import type { FilterNotes } from "./deployment-filter"
// Type-only cross-domain reference to the shared agent-mode union. Erased at
// runtime (JS output has zero coupling); resolved via the `@/*` path alias in
// app typecheck, jest, and this package's tsconfig (`@/* → ../../*`). Kept as a
// single source of truth rather than duplicated to avoid drift.
import type { AgentModeType } from "@/types/agent/agent-mode"

// Routing mode - how the router decides which model to use
export type RoutingMode = "rule-based" | "llm-based" | "hybrid"

// Routing strategy - what to optimize for
export type RoutingStrategy =
  | "reliability" // Prefer statistically healthy deployments before cost/latency
  | "quality" // Always use the best model available
  | "cost" // Minimize cost while maintaining quality
  | "speed" // Prioritize fast response times
  | "balanced" // Balance between quality, cost, and speed
  | "adaptive" // Learn from user feedback
  | "least-busy" // Route to the deployment with the fewest in-flight turns
  | "difficulty" // RouteLLM-lite: strong/weak model by scored prompt difficulty

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

export type RoutingSurface = "chat" | "gateway" | "workflow" | "council" | "agent"

export type ModelRoutingSelection =
  | {
      kind: "manual"
      providerId: string
      modelId: string
      deploymentId?: string
    }
  | { kind: "alias"; alias: string }
  | { kind: "auto" }

export interface RoutingCapabilityRequirements {
  tools?: boolean
  vision?: boolean
  audio?: boolean
  video?: boolean
  reasoning?: boolean
  structuredOutput?: boolean
  streaming?: boolean
  minContextTokens?: number
}

export interface RoutingCandidateCapabilities {
  tools?: boolean
  vision?: boolean
  audio?: boolean
  video?: boolean
  reasoning?: boolean
  structuredOutput?: boolean
  streaming?: boolean
  contextTokens?: number
}

export interface RoutingDataPolicy {
  locality: "any" | "local-only"
  allowedProviderIds?: string[]
  excludedProviderIds?: string[]
}

export interface RoutingTaskHints {
  hasCode?: boolean
  attachmentKinds?: Array<"image" | "audio" | "video" | "document">
  category?: TaskCategory
  /**
   * How many turns deep the thread is. A long thread is a different task from
   * the same words typed cold: more context to hold, more prior constraints to
   * respect. The field existed on `RoutingContext` and was never read.
   */
  messageCount?: number
  /**
   * Tools the turn can reach. Already computed at the call site as a hard
   * capability filter; as a SIGNAL it says something else — a turn that can
   * act on the world is more consequential than one that can only answer.
   */
  toolCount?: number
  /**
   * Effort the user asked for. Someone who chose `high` or `max` has already
   * said "this one is hard"; treating that as a floor is respecting an answer
   * we asked for rather than re-deriving it from their wording.
   */
  requestedEffort?: "low" | "medium" | "high" | "xhigh" | "max"
}

/**
 * The deterministic signals behind a difficulty score.
 *
 * Emitted on the routing trace so a threshold can be tuned from evidence.
 * Every field is a bounded NUMBER — never prompt text, in line with the
 * calibration pipeline's rule that it can read decisions but never content.
 */
export interface RoutingDifficultySignals {
  /** Contribution from prompt length. */
  length: number
  /** Contribution from fenced or inline code. */
  code: number
  /** Contribution from reasoning/complexity keywords. */
  keywords: number
  /** Contribution from sentence/question structure. */
  structure: number
  /** Contribution from attachments and modality. */
  attachments: number
  /** Contribution from thread depth. */
  threadDepth: number
  /** Contribution from tool availability. */
  tools: number
  /** Floor imposed by an explicitly requested effort level, if any. */
  effortFloor: number
}

export type RoutingDifficultyTier = "fast" | "balanced" | "powerful"

/**
 * What the router concluded about difficulty, and how.
 *
 * `deterministicTier` is kept beside `tier` on purpose: when a judge moved the
 * decision, the pair is the whole record of the disagreement, and shadow-mode
 * calibration needs both to say whether consulting the judge was worth it.
 */
export interface RoutingDifficultyOutcome {
  score: number
  tier: RoutingDifficultyTier
  deterministicTier: RoutingDifficultyTier
  signals: RoutingDifficultySignals
  judgeUsed: boolean
  judgeTier?: RoutingDifficultyTier
  judgeConfidence?: number
  judgeLatencyMs?: number
}

export interface RoutingRequest {
  surface: RoutingSurface
  selection: ModelRoutingSelection
  /** Ordered low-to-high aliases used when Auto maps a local classification. */
  candidateAliases?: string[]
  promptText?: string
  estimatedInputTokens?: number
  requirements?: RoutingCapabilityRequirements
  dataPolicy?: RoutingDataPolicy
  taskHints?: RoutingTaskHints
  /** Difficulty cut points used to choose the configured Auto alias tier. */
  thresholds?: { balanced: number; powerful: number }
  sessionId?: string
  strategy?: RoutingStrategy | (string & {})
  /** Compare the awaited decision with the synchronous compatibility path. */
  shadowMode?: boolean
  /**
   * Second-opinion layer for the ambiguous middle.
   *
   * The deterministic score ALWAYS runs; the judge is consulted only when the
   * score lands within `uncertaintyBand` of a tier boundary. That is what keeps
   * the always-on path free: an unambiguous prompt never pays for it, so the
   * median request gains 0 ms.
   */
  judge?: {
    enabled?: boolean
    /** Half-width around a threshold inside which the judge is consulted. */
    uncertaintyBand?: number
  }
}

export type RoutingReasonCode =
  | "manual-override"
  | "alias-match"
  | "auto-task-fit"
  | "affinity-pin"
  | "reliability-first"
  | "capability-required"
  | "context-window"
  | "data-policy"
  | "provider-unavailable"
  | "circuit-open"
  | "rate-limited"
  | "budget-exceeded"
  | "plugin-timeout"
  | "plugin-error"
  | "strategy-unavailable"
  | "cold-start"
  | "fallback-transient"
  | "fallback-context"
  | "fallback-content-policy"
  | "committed-no-replay"
  // Difficulty judge (ADR-0043 Phase 10). `agreed` when it confirmed the
  // deterministic tier, `overrode` when it moved it, `unavailable` when it was
  // consulted and returned nothing (timeout, PII gate, malformed output) — in
  // which case the deterministic tier stands, unchanged.
  | "judge-agreed"
  | "judge-overrode"
  | "judge-unavailable"
  | `plugin:${string}:${string}`
  | `filter:${string}`

export interface RouteCandidate extends ModelMappingEntry {
  deploymentId: string
  reasonCodes: RoutingReasonCode[]
}

export interface RoutingPlan {
  decisionId: string
  surface: RoutingSurface
  requested: ModelRoutingSelection
  strategy: RoutingStrategy | (string & {})
  selected: RouteCandidate
  /** Primary is always index 0; remaining entries are attempted in order. */
  orderedCandidates: RouteCandidate[]
  reasonCodes: RoutingReasonCode[]
  rejected: Array<{ reasonCode: RoutingReasonCode; count: number }>
  classification?: TaskClassification
  parameterDefaults?: ModelMappingParameterDefaults
  specialFallbacks?: ModelMappingSpecialFallbacks
  retryPolicy?: ModelMappingRetryPolicy
  overBudgetWarning?: { providerId: string; spend: number; budget: number }
  filterNotes?: FilterNotes
  /** Present for `auto` selections; absent when the caller pinned a model. */
  difficulty?: RoutingDifficultyOutcome
  shadowComparison?: {
    differs: boolean
    selected: { providerId: string; modelId: string }
  }
  replayPolicy: "pre-commit-only"
  createdAt: number
}

export type RoutingAttemptPhase =
  "planned" | "inFlight" | "committed" | "completed" | "failed" | "cancelled"

export interface RoutingAttemptState {
  decisionId: string
  phase: RoutingAttemptPhase
  candidateIndex: number
  committedAt?: number
}

/** Legacy strong/weak difficulty policy normalized into the unified router. */
export interface DifficultyRoutingSettings {
  enabled: boolean
  weakModel?: { providerId: string; modelId: string }
  strongModel?: { providerId: string; modelId: string }
  threshold: number
}

export const DEFAULT_DIFFICULTY_ROUTING: DifficultyRoutingSettings = {
  enabled: false,
  threshold: 0.5,
}

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
  /** Bounded local heuristic score used for transparent workload calibration. */
  difficultyScore?: number
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

  /** Selection used for sessions without an explicit provider/model. */
  defaultSelection: "manual" | "auto"
  /** Enforceable provider locality and allow/deny policy. */
  dataPolicy: RoutingDataPolicy
  /** Alias tiers used by the local classifier, ordered low to high. */
  candidateAliases: string[]
  /** Difficulty cut points for the alias tiers. */
  thresholds: { balanced: number; powerful: number }
  /** Compute and trace decisions without dispatching them. */
  shadowMode: boolean
  /**
   * Second-opinion difficulty judge (ADR-0043 Phase 10).
   *
   * An opt-in INSIDE an already-opted-in feature: `enabled` here does nothing
   * unless `autoRouting.enabled` is also on, so turning routing on never
   * silently starts spending model calls on classification. Default off.
   */
  judge?: {
    enabled: boolean
    /** Half-width around a tier cut point inside which the judge is consulted. */
    uncertaintyBand?: number
    /** Hard ceiling on the judge's round trip; the deterministic tier stands on expiry. */
    timeoutMs?: number
  }
}

/** Settings-store spelling retained as an alias to the canonical type. */
export type AutoRoutingSettings = AutoRouterSettings

// Default auto router settings
export const DEFAULT_AUTO_ROUTER_SETTINGS: AutoRouterSettings = {
  enabled: false,
  routingMode: "rule-based",
  strategy: "reliability",
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
  defaultSelection: "manual",
  dataPolicy: { locality: "any" },
  candidateAliases: ["fast", "balanced", "powerful"],
  thresholds: { balanced: 0.34, powerful: 0.67 },
  shadowMode: true,
  // Off by default. Shadow mode is the intended rollout path: publish the
  // decisions, mine `routing.shadow_diff` with `analyzeRoutingCalibration`,
  // then turn the layer on with evidence rather than optimism.
  judge: { enabled: false, uncertaintyBand: 0.08, timeoutMs: 400 },
}

export const DEFAULT_AUTO_ROUTING = DEFAULT_AUTO_ROUTER_SETTINGS

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
