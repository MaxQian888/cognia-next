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

import type { ModelMappingEntry, ProviderConstraint } from "./model-mapping"
import type { CircuitBreakerStateValue } from "./circuit-breaker"
import type { RoutingTelemetrySnapshot } from "./routing-strategy"
import type {
  RoutingCapabilityRequirements,
  RoutingSurface,
  TaskClassification,
} from "./auto-router"

/** One candidate route — an alias mapping entry. */
export type DeploymentCandidate = ModelMappingEntry

/** Per-request facts a filter may act on. */
export interface FilterRequest {
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
export interface FilterNotes {
  /**
   * Every candidate was over its daily budget — the budget filter kept the
   * list (advisory) and the engine attaches a warning to the selection.
   */
  overBudget?: Array<{ providerId: string; spend: number; budget: number }>
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
  filterErrors?: Array<{ filterId: string; kind: "timeout" | "error" | "invalid" }>
}

/** Read-only environment the engine hands every filter. */
export interface FilterContext {
  telemetry: RoutingTelemetrySnapshot
  /** Breaker state for one candidate (deployment-level when wired). */
  getCircuitBreakerState: (candidate: DeploymentCandidate) => CircuitBreakerStateValue
  /** Provider configured + enabled + breaker not open at provider level. */
  isAvailable: (candidate: DeploymentCandidate) => boolean
  /** Usable input window for a provider:model pair (absent → check skipped). */
  getContextWindow?: (providerId: string, modelId: string) => number
  /** Provider-level trailing-minute rate (constraint ceilings are per provider). */
  getRate?: (providerId: string) => { rpm: number; tpm: number }
  /** Deployment-level trailing-minute rate (plugin filters). */
  getDeploymentRate?: (deploymentKey: string) => { rpm: number; tpm: number }
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
export interface FilterOutcome {
  candidates: DeploymentCandidate[]
  notes?: FilterNotes
}

/** A single composable pre-call filter. `filter` MUST NOT throw. */
export interface DeploymentFilter {
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
