import { ProviderName } from "./provider.js"
import { CircuitBreakerConfig, CircuitBreakerStateValue } from "./circuit-breaker.js"
import { ProviderHealthMetrics } from "./health-metrics.js"
import { ProviderErrorClass } from "./error-class.js"

/**
 * Model Mapping type definitions
 * User-configurable alias-to-provider:model mappings with fallback chains
 */

/**
 * Persisted global circuit-breaker settings (AppSettings.routingConfig).
 * Hydrated into the in-memory breaker store on every send so reliability
 * routing survives reloads. Absent → the breaker stays opt-in-off
 * (historical behavior).
 */
interface RoutingCircuitBreakerSettings extends Partial<CircuitBreakerConfig> {
  enabled: boolean
}
/** A single entry in a model mapping's fallback chain */
interface ModelMappingEntry {
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
interface ModelMappingConditions {
  /** Maximum cost per 1M tokens (USD) — skip this entry if pricing exceeds */
  maxCostPer1M?: number
  /** Maximum latency in ms — skip this entry if recent P50 exceeds */
  maxLatencyMs?: number
}
/** Default generation parameters that apply when using an alias */
interface ModelMappingParameterDefaults {
  temperature?: number
  maxTokens?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
}
/** Distribution strategy for entries in a mapping */
type MappingDistributionStrategy = "priority" | "weighted" | "round-robin"
/**
 * Error-class-specific fallback chains (LiteLLM `context_window_fallbacks` /
 * `content_policy_fallbacks` analog). When a turn fails with one of these
 * classes the retry path routes through the dedicated chain instead of the
 * main one — a same-sized model fails a context-window error the same way,
 * so the dedicated chain points at larger-window / alternate-provider
 * entries.
 */
interface ModelMappingSpecialFallbacks {
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
type ModelMappingRetryPolicy = Partial<
  Record<
    ProviderErrorClass,
    {
      maxRetries: number
    }
  >
>
/** A complete model mapping: alias → provider:model chain */
interface ModelMapping {
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
interface ModelMappingRegistry {
  /** All model mappings keyed by alias */
  mappings: ModelMapping[]
  /** Whether the mapping system is enabled globally */
  enabled: boolean
}
/** Default registry state */
declare const DEFAULT_MODEL_MAPPING_REGISTRY: ModelMappingRegistry
/** Result of resolving a model alias */
interface AliasResolutionResult {
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
interface ProviderConstraint {
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
interface RoutingConfig {
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
declare const DEFAULT_ROUTING_CONFIG: RoutingConfig

/**
 * Pluggable routing-strategy contract (LiteLLM `CustomRoutingStrategy`
 * analog). One pure-selector interface serves the built-in strategies
 * (quality/cost/speed/balanced/adaptive/least-busy), the difficulty
 * router, and plugin-contributed strategies — they all plug into the same
 * registry consulted by `ProviderRoutingEngine.applyStrategy`.
 */

/**
 * A strategy id: one of the built-in `RoutingStrategy` union members or a
 * custom (plugin) id. `(string & {})` keeps literal autocomplete while
 * accepting arbitrary ids.
 */
type RoutingStrategyId = RoutingStrategy | (string & {})
/** Read-only telemetry surface a selector scores candidates with. */
interface RoutingTelemetrySnapshot {
  getHealthMetrics: (providerId: string) => ProviderHealthMetrics | undefined
  getPricing: (providerId: string, modelId: string) => number | undefined
  /** Concurrent in-flight requests per provider (least-busy source; 0 = idle/unknown). */
  getInFlight: (providerId: string) => number
  /** Injectable clock (adaptive's recent-error decay; deterministic tests). */
  now: () => number
  /**
   * Deployment-granular health (`providerId::modelId[::keyId]` keys — see
   * `types/provider/deployment.ts`). Optional, additive: selectors written
   * against the provider-level surface keep working unchanged.
   */
  getDeploymentHealth?: (deploymentKey: string) => ProviderHealthMetrics | undefined
  /** Deployment-granular in-flight count. Optional, additive. */
  getDeploymentInFlight?: (deploymentKey: string) => number
}
/** Per-request context available to context-aware selectors. */
interface RoutingDecisionContext {
  /** Last user prompt text, reserved for the built-in difficulty selector. */
  promptText?: string
  /** Rough token estimate of the outgoing prompt. */
  estimatedInputTokens?: number
  /** Locally derived request features available to plugin selectors. */
  classification?: TaskClassification
  requirements?: RoutingCapabilityRequirements
  surface?: RoutingSurface
}
/**
 * A pure candidate selector. MUST NOT throw for routing to stay reliable —
 * the engine treats a throwing selector as "no preference" (first entry).
 */
interface RoutingStrategySelector {
  id: RoutingStrategyId
  /** Human-readable label for strategy pickers (defaults to the id). */
  label?: string
  select: (
    entries: readonly ModelMappingEntry[],
    telemetry: RoutingTelemetrySnapshot,
    ctx?: RoutingDecisionContext
  ) => ModelMappingEntry | null
  /** Async companion used by subprocess-backed or otherwise awaitable plugins. */
  selectAsync?: (
    entries: readonly ModelMappingEntry[],
    telemetry: RoutingTelemetrySnapshot,
    ctx?: RoutingDecisionContext
  ) => Promise<ModelMappingEntry | null>
}

/**
 * Composable pre-call deployment filters (LiteLLM `async_filter_deployments`
 * analog). The routing engine runs an ordered chain of these over an alias's
 * candidate entries BEFORE strategy selection: circuit breaker, context
 * window, rate limits, budget, session affinity — plus plugin-contributed
 * filters registered through `lib/ai/routing/filter-registry`.
 *
 * Filters are pure and MUST NOT throw — the chain runner skips a throwing
 * filter so one broken plugin filter can never break dispatch.
 */

/** One candidate route — an alias mapping entry. */
type DeploymentCandidate = ModelMappingEntry
/** Per-request facts a filter may act on. */
interface FilterRequest {
  /** The alias being resolved. */
  alias?: string
  /** Rough token estimate of the outgoing prompt. */
  estimatedInputTokens?: number
  /** Locally derived request features; raw prompt text is never exposed. */
  classification?: TaskClassification
  requirements?: RoutingCapabilityRequirements
  surface?: RoutingSurface
  /** Chat session id (affinity filter). */
  sessionId?: string
}
/** Notes filters attach for the engine / preview panel to act on. */
interface FilterNotes {
  /**
   * Every candidate was over its daily budget — the budget filter kept the
   * list (advisory) and the engine attaches a warning to the selection.
   */
  overBudget?: Array<{
    providerId: string
    spend: number
    budget: number
  }>
  /**
   * Nothing fit the estimated input — the context-window filter re-ordered
   * by window size desc and the engine bypasses the strategy (largest wins).
   */
  windowFallback?: boolean
  /** A healthy affinity pin was moved to the front (deployment key). */
  affinityPinned?: string
  /** Filter ids that pruned at least one candidate (preview panel). */
  prunedBy?: string[]
  /** Filters skipped because they timed out, threw, or returned invalid data. */
  filterErrors?: Array<{
    filterId: string
    kind: "timeout" | "error" | "invalid"
  }>
}
/** Read-only environment the engine hands every filter. */
interface FilterContext {
  telemetry: RoutingTelemetrySnapshot
  /** Breaker state for one candidate (deployment-level when wired). */
  getCircuitBreakerState: (candidate: DeploymentCandidate) => CircuitBreakerStateValue
  /** Provider configured + enabled + breaker not open at provider level. */
  isAvailable: (candidate: DeploymentCandidate) => boolean
  /** Usable input window for a provider:model pair (absent → check skipped). */
  getContextWindow?: (providerId: string, modelId: string) => number
  /** Provider-level trailing-minute rate (constraint ceilings are per provider). */
  getRate?: (providerId: string) => {
    rpm: number
    tpm: number
  }
  /** Deployment-level trailing-minute rate (plugin filters). */
  getDeploymentRate?: (deploymentKey: string) => {
    rpm: number
    tpm: number
  }
  /** Durable today-spend (USD) per provider. */
  getTodaySpend?: (providerId: string) => number
  /** Active provider constraints from the routing config. */
  constraints: ReadonlyArray<ProviderConstraint>
  /** Session → pinned deployment key lookup (affinity filter). */
  getSessionDeployment?: (sessionId: string) => string | undefined
  /** Release an unhealthy pin (affinity filter health-aware release). */
  releaseSessionDeployment?: (sessionId: string) => void
  /** Injectable clock. */
  now: () => number
}
/** A filter's verdict: surviving candidates + optional notes. */
interface FilterOutcome {
  candidates: DeploymentCandidate[]
  notes?: FilterNotes
}
/** A single composable pre-call filter. `filter` MUST NOT throw. */
interface DeploymentFilter {
  id: string
  /** Human-readable label for settings UI (defaults to the id). */
  label?: string
  filter: (
    candidates: readonly DeploymentCandidate[],
    req: FilterRequest,
    ctx: FilterContext
  ) => FilterOutcome
  /** Async companion used by subprocess-backed or otherwise awaitable plugins. */
  filterAsync?: (
    candidates: readonly DeploymentCandidate[],
    req: FilterRequest,
    ctx: FilterContext
  ) => Promise<FilterOutcome>
}

/**
 * Agent Mode type definitions
 * Defines different agent sub-modes like web design, code generation, etc.
 */
type AgentModeType =
  | "general"
  | "web-design"
  | "code-gen"
  | "data-analysis"
  | "writing"
  | "research"
  | "ppt-generation"
  | "workflow"
  | "academic"
  | "plan"
  | "build"
  | "plugin"
  | "custom"

/**
 * Auto Router type definitions
 * Intelligent model selection based on task complexity and requirements
 */

type RoutingMode = "rule-based" | "llm-based" | "hybrid"
type RoutingStrategy =
  | "reliability"
  | "quality"
  | "cost"
  | "speed"
  | "balanced"
  | "adaptive"
  | "least-busy"
  | "difficulty"
type ModelTier = "fast" | "balanced" | "powerful" | "reasoning"
type TaskComplexity = "simple" | "moderate" | "complex" | "expert"
type TaskCategory =
  | "general"
  | "coding"
  | "analysis"
  | "creative"
  | "research"
  | "conversation"
  | "math"
  | "translation"
  | "summarization"
type RoutingSurface = "chat" | "gateway" | "workflow" | "council" | "agent"
type ModelRoutingSelection =
  | {
      kind: "manual"
      providerId: string
      modelId: string
      deploymentId?: string
    }
  | {
      kind: "alias"
      alias: string
    }
  | {
      kind: "auto"
    }
interface RoutingCapabilityRequirements {
  tools?: boolean
  vision?: boolean
  audio?: boolean
  video?: boolean
  reasoning?: boolean
  structuredOutput?: boolean
  streaming?: boolean
  minContextTokens?: number
}
interface RoutingCandidateCapabilities {
  tools?: boolean
  vision?: boolean
  audio?: boolean
  video?: boolean
  reasoning?: boolean
  structuredOutput?: boolean
  streaming?: boolean
  contextTokens?: number
}
interface RoutingDataPolicy {
  locality: "any" | "local-only"
  allowedProviderIds?: string[]
  excludedProviderIds?: string[]
}
interface RoutingTaskHints {
  hasCode?: boolean
  attachmentKinds?: Array<"image" | "audio" | "video" | "document">
  category?: TaskCategory
}
interface RoutingRequest {
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
  thresholds?: {
    balanced: number
    powerful: number
  }
  sessionId?: string
  strategy?: RoutingStrategy | (string & {})
  /** Compare the awaited decision with the synchronous compatibility path. */
  shadowMode?: boolean
}
type RoutingReasonCode =
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
  | `plugin:${string}:${string}`
  | `filter:${string}`
interface RouteCandidate extends ModelMappingEntry {
  deploymentId: string
  reasonCodes: RoutingReasonCode[]
}
interface RoutingPlan {
  decisionId: string
  surface: RoutingSurface
  requested: ModelRoutingSelection
  strategy: RoutingStrategy | (string & {})
  selected: RouteCandidate
  /** Primary is always index 0; remaining entries are attempted in order. */
  orderedCandidates: RouteCandidate[]
  reasonCodes: RoutingReasonCode[]
  rejected: Array<{
    reasonCode: RoutingReasonCode
    count: number
  }>
  classification?: TaskClassification
  parameterDefaults?: ModelMappingParameterDefaults
  specialFallbacks?: ModelMappingSpecialFallbacks
  retryPolicy?: ModelMappingRetryPolicy
  overBudgetWarning?: {
    providerId: string
    spend: number
    budget: number
  }
  filterNotes?: FilterNotes
  shadowComparison?: {
    differs: boolean
    selected: {
      providerId: string
      modelId: string
    }
  }
  replayPolicy: "pre-commit-only"
  createdAt: number
}
type RoutingAttemptPhase =
  "planned" | "inFlight" | "committed" | "completed" | "failed" | "cancelled"
interface RoutingAttemptState {
  decisionId: string
  phase: RoutingAttemptPhase
  candidateIndex: number
  committedAt?: number
}
/** Legacy strong/weak difficulty policy normalized into the unified router. */
interface DifficultyRoutingSettings {
  enabled: boolean
  weakModel?: {
    providerId: string
    modelId: string
  }
  strongModel?: {
    providerId: string
    modelId: string
  }
  threshold: number
}
declare const DEFAULT_DIFFICULTY_ROUTING: DifficultyRoutingSettings
interface ModelCapabilities {
  supportsVision: boolean
  supportsTools: boolean
  supportsStreaming: boolean
  supportsReasoning: boolean
  contextLength: number
  maxOutputTokens?: number
}
interface TaskClassification {
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
  confidence: number
  agentModeHint?: AgentModeType
}
interface ModelSelection {
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
interface RouterModelConfig {
  provider: ProviderName
  model: string
  priority: number
}
interface TierModelEntry {
  provider: ProviderName
  model: string
  priority?: number
  capabilities?: Partial<ModelCapabilities>
}
interface AutoRouterSettings {
  enabled: boolean
  routingMode: RoutingMode
  strategy: RoutingStrategy
  showRoutingIndicator: boolean
  allowOverride: boolean
  preferredProviders: ProviderName[]
  excludedProviders: ProviderName[]
  maxCostPerRequest?: number
  customTierModels?: {
    fast?: TierModelEntry[]
    balanced?: TierModelEntry[]
    powerful?: TierModelEntry[]
    reasoning?: TierModelEntry[]
  }
  routerModel?: RouterModelConfig
  enableCache: boolean
  cacheTTL: number
  fallbackTier: ModelTier
  fallbackProvider?: ProviderName
  /** Selection used for sessions without an explicit provider/model. */
  defaultSelection: "manual" | "auto"
  /** Enforceable provider locality and allow/deny policy. */
  dataPolicy: RoutingDataPolicy
  /** Alias tiers used by the local classifier, ordered low to high. */
  candidateAliases: string[]
  /** Difficulty cut points for the alias tiers. */
  thresholds: {
    balanced: number
    powerful: number
  }
  /** Compute and trace decisions without dispatching them. */
  shadowMode: boolean
}
/** Settings-store spelling retained as an alias to the canonical type. */
type AutoRoutingSettings = AutoRouterSettings
declare const DEFAULT_AUTO_ROUTER_SETTINGS: AutoRouterSettings
declare const DEFAULT_AUTO_ROUTING: AutoRouterSettings
interface RoutingCacheEntry {
  key: string
  selection: ModelSelection
  timestamp: number
  hitCount: number
}
interface RoutingStats {
  totalRequests: number
  byTier: Record<ModelTier, number>
  byProvider: Record<string, number>
  byCategory: Record<TaskCategory, number>
  avgLatency: number
  cacheHitRate: number
  estimatedCostSaved: number
}
interface RoutingContext {
  sessionId?: string
  messageCount?: number
  previousModels?: string[]
  agentMode?: AgentModeType
  agentTools?: string[]
  hasImages?: boolean
  hasDocuments?: boolean
  hasCode?: boolean
  userPreferredProvider?: ProviderName
  userPreferredTier?: ModelTier
  preferFastResponse?: boolean
  preferHighQuality?: boolean
  activeSkillCategories?: string[]
  activeSkillCount?: number
}
interface RequestRoutingOverride {
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
interface RoutingEvent {
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

export {
  type TaskCategory as $,
  type AliasResolutionResult as A,
  type RoutingAttemptState as B,
  type RoutingCacheEntry as C,
  DEFAULT_AUTO_ROUTER_SETTINGS as D,
  type RoutingCandidateCapabilities as E,
  type FilterContext as F,
  type RoutingCapabilityRequirements as G,
  type RoutingCircuitBreakerSettings as H,
  type RoutingConfig as I,
  type RoutingContext as J,
  type RoutingDataPolicy as K,
  type RoutingDecisionContext as L,
  type MappingDistributionStrategy as M,
  type RoutingEvent as N,
  type RoutingMode as O,
  type ProviderConstraint as P,
  type RoutingPlan as Q,
  type RequestRoutingOverride as R,
  type RoutingReasonCode as S,
  type RoutingRequest as T,
  type RoutingStats as U,
  type RoutingStrategy as V,
  type RoutingStrategyId as W,
  type RoutingStrategySelector as X,
  type RoutingSurface as Y,
  type RoutingTaskHints as Z,
  type RoutingTelemetrySnapshot as _,
  type AutoRouterSettings as a,
  type TaskClassification as a0,
  type TaskComplexity as a1,
  type TierModelEntry as a2,
  type AutoRoutingSettings as b,
  DEFAULT_AUTO_ROUTING as c,
  DEFAULT_DIFFICULTY_ROUTING as d,
  DEFAULT_MODEL_MAPPING_REGISTRY as e,
  DEFAULT_ROUTING_CONFIG as f,
  type DeploymentCandidate as g,
  type DeploymentFilter as h,
  type DifficultyRoutingSettings as i,
  type FilterNotes as j,
  type FilterOutcome as k,
  type FilterRequest as l,
  type ModelCapabilities as m,
  type ModelMapping as n,
  type ModelMappingConditions as o,
  type ModelMappingEntry as p,
  type ModelMappingParameterDefaults as q,
  type ModelMappingRegistry as r,
  type ModelMappingRetryPolicy as s,
  type ModelMappingSpecialFallbacks as t,
  type ModelRoutingSelection as u,
  type ModelSelection as v,
  type ModelTier as w,
  type RouteCandidate as x,
  type RouterModelConfig as y,
  type RoutingAttemptPhase as z,
}
