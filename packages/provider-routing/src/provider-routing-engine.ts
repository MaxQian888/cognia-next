/**
 * Provider Routing Engine
 *
 * Intercepts AI requests and selects the optimal provider:model pair based on
 * configured routing strategy, model mappings, and real-time health metrics.
 *
 * This is the core runtime that connects model aliases, routing strategies,
 * circuit breakers, and health metrics into a unified provider selection flow.
 */

import type {
  ModelMappingEntry,
  ModelMappingRegistry,
  ModelMappingRetryPolicy,
  ModelMappingSpecialFallbacks,
  RoutingConfig,
  AliasResolutionResult,
} from "@cognia/provider-types/model-mapping"
import type { RequestRoutingOverride } from "@cognia/provider-types/auto-router"
import type {
  RouteCandidate,
  RoutingCandidateCapabilities,
  RoutingPlan,
  RoutingReasonCode,
  RoutingRequest,
} from "@cognia/provider-types/auto-router"
import type {
  RoutingDecisionContext,
  RoutingStrategyId,
  RoutingTelemetrySnapshot,
} from "@cognia/provider-types/routing-strategy"
import type { ProviderHealthMetrics } from "@cognia/provider-types/health-metrics"
import type { CircuitBreakerStateValue } from "@cognia/provider-types/circuit-breaker"
import type {
  FilterContext,
  FilterNotes,
  FilterRequest,
} from "@cognia/provider-types/deployment-filter"
import type {
  RoutingDifficultyOutcome,
  RoutingDifficultySignals,
  RoutingDifficultyTier,
} from "@cognia/provider-types/auto-router"
import { deploymentKeyOfEntry } from "@cognia/provider-types/deployment"
import type { ProviderName } from "@cognia/provider-types"
import { resolveModelAlias, type ProviderHealthMetricsLite } from "./alias-resolver"
import { DEFAULT_FILTER_CHAIN, getDeploymentFilter } from "./filter-registry"
import { runFilterChain, runFilterChainAsync } from "./run-filter-chain"
import { getProviderRoutingRuntimeAdapters } from "./runtime-adapters"
import { getRoutingStrategy } from "./strategy-registry"
import {
  classifyRoutingTask,
  deterministicDifficulty,
  difficultyTier,
  isAmbiguousDifficulty,
  pickAutoAlias,
  scoreDifficulty,
} from "./difficulty-router"

/** Provider info needed for routing decisions */
export interface ProviderRoutingInfo {
  providerId: string
  modelId: string
  /** Known pricing per 1M prompt tokens (USD) */
  pricingPer1M?: number
}

/** Dependencies injected into the routing engine */
export interface RoutingEngineDeps {
  /**
   * Second-opinion difficulty classifier, consulted ONLY for scores near a
   * tier boundary.
   *
   * Injected rather than imported so this package stays free of any LLM
   * dependency — the same seam `getPricing` and `getCapabilities` use. A host
   * that wires nothing keeps a purely deterministic router, and a judge that
   * throws, times out, or returns nothing leaves the deterministic tier
   * standing: the layer can only ever improve a decision it was unsure of.
   */
  judgeDifficulty?: (input: {
    promptText: string
    deterministicScore: number
    deterministicTier: RoutingDifficultyTier
    signalsOnly: RoutingDifficultySignals
  }) => Promise<{ tier: RoutingDifficultyTier; confidence?: number } | null>
  /** Get health metrics for a provider */
  getHealthMetrics: (providerId: string) => ProviderHealthMetrics | undefined
  /** Get circuit breaker state for a provider */
  getCircuitBreakerState: (providerId: string) => CircuitBreakerStateValue
  /** Check if a provider is configured and enabled */
  isProviderAvailable: (providerId: string) => boolean
  /** Get pricing for a provider:model pair */
  getPricing: (providerId: string, modelId: string) => number | undefined
  /**
   * Today's spend for a provider in USD (durable mirror, survives reloads).
   * Optional: when absent the budget check falls back to the in-memory health
   * metrics' session-scoped totalCost.
   */
  getTodaySpend?: (providerId: string) => number
  /**
   * Usable input context window (tokens) for a provider:model pair — the raw
   * window minus an output/reserve allowance, resolved by the caller from the
   * model catalog. Optional: when absent the context-window pre-check is
   * skipped entirely.
   */
  getContextWindow?: (providerId: string, modelId: string) => number
  /**
   * Trailing-minute request/token rate for a provider (reactive, post-turn).
   * Optional: when absent the RPM/TPM pre-check is skipped entirely.
   */
  getRate?: (providerId: string) => { rpm: number; tpm: number }
  /**
   * Concurrent in-flight requests per provider — the least-busy strategy's
   * signal. Optional: when absent every provider reads 0 and least-busy
   * degrades to chain order.
   */
  getInFlight?: (providerId: string) => number
  /** Injectable clock for deterministic strategy tests. */
  now?: () => number

  // ---- Deployment granularity (all optional, additive) -------------------
  // Keys are `providerId::modelId[::keyId]` — see `types/provider/deployment.ts`.

  /** Deployment-granular health metrics. */
  getDeploymentHealth?: (deploymentKey: string) => ProviderHealthMetrics | undefined
  /** Deployment-granular breaker state (falls back to provider-level). */
  getDeploymentCircuitBreakerState?: (deploymentKey: string) => CircuitBreakerStateValue
  /** Deployment-granular trailing-minute rate. */
  getDeploymentRate?: (deploymentKey: string) => { rpm: number; tpm: number }
  /** Deployment-granular in-flight count. */
  getDeploymentInFlight?: (deploymentKey: string) => number
  /** Session → pinned deployment key (affinity filter). */
  getSessionDeployment?: (sessionId: string) => string | undefined
  /** Release an unhealthy affinity pin. */
  releaseSessionDeployment?: (sessionId: string) => void
  /** Dynamic enabled provider/model catalog used by explicit Auto routing. */
  listCandidates?: () => readonly ModelMappingEntry[]
  /** Catalog capabilities. Unknown required capabilities fail closed. */
  getCapabilities?: (
    providerId: string,
    modelId: string
  ) => RoutingCandidateCapabilities | undefined
  /** Locality source for the enforceable local-only data policy. */
  isLocalProvider?: (providerId: string) => boolean
}

let decisionSequence = 0

/**
 * Thrown when an alias matched but the pre-call filter chain emptied the
 * candidate set (every deployment open/unavailable). `selectProvider` keeps
 * returning `null` ONLY for the no-alias passthrough — callers catch this to
 * surface a clear "no viable provider" error instead of silently passing
 * the alias string through as a model id.
 */
export class RoutingNoCandidatesError extends Error {
  readonly alias: string
  constructor(alias: string) {
    super(`No viable provider for alias "${alias}" — every candidate is unavailable`)
    this.name = "RoutingNoCandidatesError"
    this.alias = alias
  }
}

/** Result of the routing engine's provider selection */
export interface RoutingResult {
  /** Selected provider ID */
  providerId: string
  /** Selected model ID */
  modelId: string
  /** The strategy that was used (a built-in or a registered custom id) */
  strategy: RoutingStrategyId
  /** Whether this was resolved from an alias */
  fromAlias: boolean
  /** The alias that was resolved (if any) */
  alias?: string
  /** Remaining fallback entries (for fallback executor) */
  fallbackEntries: ModelMappingEntry[]
  /** Parameter defaults from the mapping (if alias was used) */
  parameterDefaults?: AliasResolutionResult["parameterDefaults"]
  /** Error-class-specific fallback chains declared on the mapping. */
  specialFallbacks?: ModelMappingSpecialFallbacks
  /** Per-error-class retry budgets declared on the mapping. */
  retryPolicy?: ModelMappingRetryPolicy
  /** Reason for the selection */
  reason: string
  /**
   * Set when the selected provider is over its daily cost budget but was the
   * only viable candidate (advisory budgets never dead-end a send). The
   * renderer surfaces this as a once-per-day toast.
   */
  overBudgetWarning?: { providerId: string; spend: number; budget: number }
  /** Merged notes from the pre-call filter chain (preview/test panel). */
  filterNotes?: FilterNotes
}

/**
 * Provider Routing Engine
 *
 * Usage:
 * ```ts
 * const engine = new ProviderRoutingEngine(registry, config, deps);
 * const result = engine.selectProvider({ modelAlias: 'fast' });
 * // result.providerId, result.modelId, result.fallbackEntries
 * ```
 */
/** Midpoint of a tier's band — the score a judge's verdict maps back onto. */
function scoreForTier(
  tier: RoutingDifficultyTier,
  thresholds: { balanced: number; powerful: number }
): number {
  if (tier === "fast") return Math.max(0, thresholds.balanced / 2)
  if (tier === "balanced") return (thresholds.balanced + thresholds.powerful) / 2
  return Math.min(1, (thresholds.powerful + 1) / 2)
}

export class ProviderRoutingEngine {
  constructor(
    private registry: ModelMappingRegistry,
    private config: RoutingConfig,
    private deps: RoutingEngineDeps
  ) {}

  /**
   * Canonical routing API. Unlike selectProvider, this awaits plugin
   * strategies/filters and returns one complete, ordered attempt plan.
   */
  async planRoute(request: RoutingRequest): Promise<RoutingPlan> {
    const strategy = request.strategy ?? this.config.strategy
    const classification =
      request.selection.kind === "auto"
        ? classifyRoutingTask({
            text: request.promptText ?? "",
            estimatedInputTokens: request.estimatedInputTokens,
            requirements: request.requirements,
            taskHints: request.taskHints,
          })
        : undefined

    let entries: ModelMappingEntry[]
    let alias: string | undefined
    let parameterDefaults: AliasResolutionResult["parameterDefaults"]
    let specialFallbacks: ModelMappingSpecialFallbacks | undefined
    let retryPolicy: ModelMappingRetryPolicy | undefined
    let difficulty: RoutingDifficultyOutcome | undefined
    const reasonCodes: RoutingReasonCode[] = []

    if (request.selection.kind === "manual") {
      entries = [
        {
          providerId: request.selection.providerId,
          modelId: request.selection.modelId,
        },
      ]
      reasonCodes.push("manual-override")
    } else if (request.selection.kind === "alias") {
      alias = request.selection.alias
      const resolution = resolveModelAlias(alias, this.registry, this.buildLiteMetricsMap(alias))
      if (!resolution.found || resolution.entries.length === 0) {
        throw new RoutingNoCandidatesError(alias)
      }
      entries = resolution.entries
      parameterDefaults = resolution.parameterDefaults
      specialFallbacks = resolution.mapping?.specialFallbacks
      retryPolicy = resolution.mapping?.retryPolicy
      reasonCodes.push("alias-match")
    } else {
      const configuredAliases = request.candidateAliases?.filter(Boolean)
      const availableAliases = new Set(
        this.registry.mappings
          .filter((mapping) => mapping.enabled)
          .map((mapping) => mapping.alias.toLowerCase())
      )
      const thresholds = request.thresholds ?? { balanced: 0.34, powerful: 0.67 }
      difficulty = await this.resolveDifficulty(request, thresholds)
      if (difficulty.judgeUsed) {
        reasonCodes.push(
          difficulty.judgeTier === undefined
            ? "judge-unavailable"
            : difficulty.judgeTier === difficulty.deterministicTier
              ? "judge-agreed"
              : "judge-overrode"
        )
      }
      const preferredAlias = pickAutoAlias(
        difficulty.score,
        configuredAliases?.length ? configuredAliases : ["fast", "balanced", "powerful"],
        thresholds,
        availableAliases
      )
      const resolution = resolveModelAlias(
        preferredAlias ?? "",
        this.registry,
        this.buildLiteMetricsMap(preferredAlias ?? "")
      )
      if (resolution.found && resolution.entries.length > 0) {
        alias = preferredAlias
        entries = resolution.entries
        parameterDefaults = resolution.parameterDefaults
        specialFallbacks = resolution.mapping?.specialFallbacks
        retryPolicy = resolution.mapping?.retryPolicy
      } else {
        const liveCandidates = this.deps.listCandidates?.() ?? []
        entries = this.dedupeEntries(
          liveCandidates.length > 0
            ? liveCandidates
            : this.registry.mappings
                .filter((mapping) => mapping.enabled)
                .flatMap((mapping) => mapping.providers)
        )
      }
      if (entries.length === 0) throw new RoutingNoCandidatesError("auto")
      reasonCodes.push("auto-task-fit")
    }

    const hardFiltered = this.applyHardConstraints(entries, request)
    if (hardFiltered.candidates.length === 0) {
      throw new RoutingNoCandidatesError(alias ?? request.selection.kind)
    }

    const req: FilterRequest = {
      alias,
      estimatedInputTokens: request.estimatedInputTokens,
      sessionId: request.sessionId,
      classification,
      requirements: request.requirements,
      surface: request.surface,
    }
    const chain = (this.config.filterChain ?? DEFAULT_FILTER_CHAIN)
      .map((id) => getDeploymentFilter(id))
      .filter((filter): filter is NonNullable<typeof filter> => filter !== undefined)
    const filtered = await runFilterChainAsync(
      chain,
      hardFiltered.candidates,
      req,
      this.filterContext(),
      this.config.pluginTimeoutMs ?? 250
    )
    if (filtered.candidates.length === 0) {
      throw new RoutingNoCandidatesError(alias ?? request.selection.kind)
    }

    const bypassStrategy = Boolean(filtered.notes?.windowFallback || filtered.notes?.affinityPinned)
    const decisionContext: RoutingDecisionContext = {
      estimatedInputTokens: request.estimatedInputTokens,
      classification,
      requirements: request.requirements,
      surface: request.surface,
      // Raw prompt text is reserved for the built-in deterministic selector.
      ...(strategy === "difficulty" ? { promptText: request.promptText } : {}),
    }
    const selectionResult = bypassStrategy
      ? { selected: filtered.candidates[0], reasonCode: undefined }
      : await this.applyStrategyAsync(filtered.candidates, strategy, decisionContext)
    const selected = selectionResult.selected ?? filtered.candidates[0]
    if (!selected) throw new RoutingNoCandidatesError(alias ?? request.selection.kind)
    if (selectionResult.reasonCode) reasonCodes.push(selectionResult.reasonCode)
    if (filtered.notes?.affinityPinned) reasonCodes.push("affinity-pin")
    if (strategy === "reliability" && request.selection.kind !== "manual") {
      reasonCodes.push("reliability-first")
    }
    for (const error of filtered.notes?.filterErrors ?? []) {
      reasonCodes.push(error.kind === "timeout" ? "plugin-timeout" : "plugin-error")
    }

    const orderedEntries = [
      selected,
      ...filtered.candidates.filter(
        (entry) => entry.providerId !== selected.providerId || entry.modelId !== selected.modelId
      ),
    ]
    const orderedCandidates = orderedEntries.map((entry, index) =>
      this.toRouteCandidate(entry, index === 0 ? reasonCodes : [])
    )
    const rejected = Array.from(hardFiltered.rejected.entries()).map(([reasonCode, count]) => ({
      reasonCode,
      count,
    }))
    const shadowSelected =
      request.shadowMode && request.selection.kind !== "manual"
        ? this.applyStrategy(filtered.candidates, strategy, decisionContext)
        : null

    return {
      decisionId: `${this.deps.now?.() ?? Date.now()}-${++decisionSequence}`,
      surface: request.surface,
      requested: request.selection,
      strategy,
      selected: orderedCandidates[0],
      orderedCandidates,
      reasonCodes: [...new Set(reasonCodes)],
      rejected,
      classification,
      parameterDefaults,
      specialFallbacks,
      retryPolicy,
      overBudgetWarning: filtered.notes?.overBudget?.find(
        (warning) => warning.providerId === selected.providerId
      ),
      filterNotes: filtered.notes,
      ...(difficulty ? { difficulty } : {}),
      ...(shadowSelected
        ? {
            shadowComparison: {
              differs:
                shadowSelected.providerId !== selected.providerId ||
                shadowSelected.modelId !== selected.modelId,
              selected: {
                providerId: shadowSelected.providerId,
                modelId: shadowSelected.modelId,
              },
            },
          }
        : {}),
      replayPolicy: "pre-commit-only",
      createdAt: this.deps.now?.() ?? Date.now(),
    }
  }

  /**
   * Deterministic score first, judge only in the ambiguous band.
   *
   * The ordering is the design. The deterministic pass ALWAYS runs and always
   * produces a usable tier, so the judge is never load-bearing: it is asked
   * only when the score sits within `uncertaintyBand` of a cut point, and any
   * failure — timeout, refusal, malformed answer — leaves the deterministic
   * tier exactly where it was. An unambiguous prompt pays nothing, which is
   * why the median request gains 0 ms from this layer existing.
   */
  private async resolveDifficulty(
    request: RoutingRequest,
    thresholds: { balanced: number; powerful: number }
  ): Promise<RoutingDifficultyOutcome> {
    const promptText = request.promptText ?? ""
    const { score, signals } = deterministicDifficulty({
      text: promptText,
      ...(request.taskHints ? { taskHints: request.taskHints } : {}),
      ...(request.requirements ? { requirements: request.requirements } : {}),
    })
    const deterministicTier = difficultyTier(score, thresholds)
    const base: RoutingDifficultyOutcome = {
      score,
      tier: deterministicTier,
      deterministicTier,
      signals,
      judgeUsed: false,
    }

    const judge = this.deps.judgeDifficulty
    // Request wins; otherwise the user's own setting, read through the same
    // runtime seam the difficulty strategy uses. Without the fallback the
    // feature would be unreachable from every existing call site.
    const judgeSettings =
      request.judge ?? getProviderRoutingRuntimeAdapters().getAutoRoutingJudgeSettings()
    if (!judge || judgeSettings?.enabled !== true) return base
    const band = judgeSettings.uncertaintyBand ?? 0.08
    if (!isAmbiguousDifficulty(score, thresholds, band)) return base

    const startedAt = this.deps.now?.() ?? Date.now()
    let verdict: { tier: RoutingDifficultyTier; confidence?: number } | null = null
    try {
      verdict = await judge({
        promptText,
        deterministicScore: score,
        deterministicTier,
        signalsOnly: signals satisfies RoutingDifficultySignals,
      })
    } catch {
      verdict = null
    }
    const judgeLatencyMs = (this.deps.now?.() ?? Date.now()) - startedAt

    return {
      ...base,
      judgeUsed: true,
      judgeLatencyMs,
      ...(verdict
        ? {
            tier: verdict.tier,
            judgeTier: verdict.tier,
            ...(verdict.confidence !== undefined ? { judgeConfidence: verdict.confidence } : {}),
            // The alias ladder is chosen from the SCORE, so a judge that moves
            // the tier has to move the score with it — otherwise the verdict
            // would be recorded and then ignored, which is worse than not
            // asking. Snapped to the midpoint of the chosen band.
            score: scoreForTier(verdict.tier, thresholds),
          }
        : {}),
    }
  }

  /**
   * Select the best provider:model for a request.
   *
   * If a direct provider+model is specified (no alias), it's returned as-is.
   * If a model alias is used, it resolves through the mapping registry and
   * applies the configured routing strategy.
   */
  selectProvider(options: {
    /** Direct provider (bypasses alias routing) */
    provider?: ProviderName
    /** Direct model (bypasses alias routing) */
    model?: string
    /** Routing override for this specific request */
    override?: RequestRoutingOverride
    /**
     * Rough token estimate of the outgoing prompt. When provided (and
     * `deps.getContextWindow` is wired) entries whose window can't fit the
     * input are deprioritized — LiteLLM-style context-window pre-check.
     */
    estimatedInputTokens?: number
    /**
     * Last user prompt text, forwarded to context-aware custom selectors
     * (e.g. the difficulty router). Built-in strategies ignore it.
     */
    promptText?: string
    /**
     * Chat session id — enables the affinity filter to keep multi-turn
     * conversations on the deployment that served the previous turn.
     */
    sessionId?: string
  }): RoutingResult | null {
    const override = options.override

    // Force provider/model bypasses all routing
    if (override?.forceProvider && override?.forceModel) {
      return {
        providerId: override.forceProvider,
        modelId: override.forceModel,
        strategy: this.config.strategy,
        fromAlias: false,
        fallbackEntries: [],
        reason: "Force override",
      }
    }

    // Check for model alias (from override or direct model string)
    const alias = override?.modelAlias || options.model
    if (alias && this.registry.enabled) {
      const resolution = resolveModelAlias(alias, this.registry, this.buildLiteMetricsMap(alias))
      if (resolution.found && resolution.entries.length > 0) {
        const result = this.selectFromEntries(
          resolution.entries,
          override?.strategy || this.config.strategy,
          alias,
          resolution.parameterDefaults,
          options.estimatedInputTokens,
          options.promptText,
          options.sessionId
        )
        // Ride the mapping's error-class routing metadata along so the
        // renderer's retry path can act on it without a registry lookup.
        if (result && resolution.mapping) {
          if (resolution.mapping.specialFallbacks) {
            result.specialFallbacks = resolution.mapping.specialFallbacks
          }
          if (resolution.mapping.retryPolicy) {
            result.retryPolicy = resolution.mapping.retryPolicy
          }
        }
        return result
      }
    }

    // Direct provider:model passthrough (no alias match)
    if (options.provider && options.model) {
      return {
        providerId: options.provider,
        modelId: options.model,
        strategy: this.config.strategy,
        fromAlias: false,
        fallbackEntries: [],
        reason: "Direct provider:model specification",
      }
    }

    return null
  }

  /**
   * Build the per-entry lite metrics map the alias resolver needs to evaluate
   * ModelMappingConditions (maxCostPer1M / maxLatencyMs). Cost comes from the
   * static pricing catalog (a price ceiling check); latency comes from recent
   * health metrics. Missing info is left undefined so the resolver treats the
   * condition as "no info -> pass".
   */
  private buildLiteMetricsMap(
    alias: string
  ): Record<string, ProviderHealthMetricsLite> | undefined {
    const normalizedAlias = alias.toLowerCase()
    const mapping = this.registry.mappings.find(
      (m) => m.enabled && m.alias.toLowerCase() === normalizedAlias
    )
    if (!mapping) return undefined

    const map: Record<string, ProviderHealthMetricsLite> = {}
    for (const entry of mapping.providers) {
      const p50 = this.deps.getHealthMetrics(entry.providerId)?.latencyP50
      map[`${entry.providerId}:${entry.modelId}`] = {
        costPer1M: this.deps.getPricing(entry.providerId, entry.modelId),
        // latencyP50 of 0 means "no data yet" — never trip a latency condition on it.
        latencyMs: p50 && p50 > 0 ? p50 : undefined,
      }
    }
    return map
  }

  /**
   * Select the best entry from a resolved alias: run the composable pre-call
   * filter chain (circuit / context-window / rate-limit / budget / affinity /
   * plugin filters), then the routing strategy over the survivors.
   *
   * @throws RoutingNoCandidatesError when the chain empties the set — the
   * alias matched, so silently passing it through as a model id would fail
   * anyway with a worse error.
   */
  private selectFromEntries(
    entries: ModelMappingEntry[],
    strategy: RoutingStrategyId,
    alias: string,
    parameterDefaults?: AliasResolutionResult["parameterDefaults"],
    estimatedInputTokens?: number,
    promptText?: string,
    sessionId?: string
  ): RoutingResult | null {
    const req: FilterRequest = { alias, estimatedInputTokens, sessionId }
    const chain = (this.config.filterChain ?? DEFAULT_FILTER_CHAIN)
      .map((id) => getDeploymentFilter(id))
      .filter((f): f is NonNullable<typeof f> => f !== undefined)

    const { candidates, notes } = runFilterChain(chain, entries, req, this.filterContext())
    if (candidates.length === 0) throw new RoutingNoCandidatesError(alias)

    // Window-fallback keeps the window-desc order; a healthy affinity pin
    // wins outright (stickiness beats per-request optimization — LiteLLM
    // affinity semantics). Otherwise the strategy picks.
    const bypassStrategy = Boolean(notes?.windowFallback || notes?.affinityPinned)
    const selected = bypassStrategy
      ? candidates[0]
      : this.applyStrategy(candidates, strategy, { promptText, estimatedInputTokens })
    if (!selected) return null

    const fallbackEntries = candidates.filter(
      (e) => !(e.providerId === selected.providerId && e.modelId === selected.modelId)
    )

    const overBudgetWarning = notes?.overBudget?.find((w) => w.providerId === selected.providerId)

    const reason = notes?.windowFallback
      ? `Estimated input exceeds every candidate's context window — picked the largest window from alias "${alias}"`
      : notes?.affinityPinned
        ? `Session pinned to ${notes.affinityPinned} (affinity) from alias "${alias}"`
        : `Selected via ${strategy} strategy from alias "${alias}"`

    return {
      providerId: selected.providerId,
      modelId: selected.modelId,
      strategy,
      fromAlias: true,
      alias,
      fallbackEntries,
      parameterDefaults,
      reason,
      ...(overBudgetWarning ? { overBudgetWarning } : {}),
      ...(notes && Object.keys(notes).length > 0 ? { filterNotes: notes } : {}),
    }
  }

  /** The read-only environment every pre-call filter runs against. */
  private filterContext(): FilterContext {
    const deps = this.deps
    return {
      telemetry: this.telemetrySnapshot(),
      getCircuitBreakerState: (e) => {
        // Deployment-level breaker when wired; provider-level otherwise.
        if (deps.getDeploymentCircuitBreakerState) {
          const key = deploymentKeyOfEntry(e)
          if (key) return deps.getDeploymentCircuitBreakerState(key)
        }
        return deps.getCircuitBreakerState(e.providerId)
      },
      isAvailable: (e) => deps.isProviderAvailable(e.providerId),
      getContextWindow: deps.getContextWindow,
      getRate: deps.getRate,
      getDeploymentRate: deps.getDeploymentRate,
      getTodaySpend: deps.getTodaySpend,
      constraints: this.config.providerConstraints,
      getSessionDeployment: deps.getSessionDeployment,
      releaseSessionDeployment: deps.releaseSessionDeployment,
      now: deps.now ?? (() => Date.now()),
    }
  }

  /**
   * Select a single entry based on the routing strategy.
   *
   * Delegates to the strategy registry (built-ins + plugin-registered
   * customs). Unknown ids and throwing selectors degrade to the first
   * entry — the historical `default` arm — so a broken custom strategy
   * can never break dispatch.
   */
  private applyStrategy(
    entries: ModelMappingEntry[],
    strategy: RoutingStrategyId,
    ctx?: RoutingDecisionContext
  ): ModelMappingEntry | null {
    if (entries.length === 0) return null
    if (entries.length === 1) return entries[0]

    const selector = getRoutingStrategy(strategy)
    if (!selector) return entries[0]
    try {
      return selector.select(entries, this.telemetrySnapshot(), ctx) ?? entries[0]
    } catch {
      return entries[0]
    }
  }

  private async applyStrategyAsync(
    entries: ModelMappingEntry[],
    strategy: RoutingStrategyId,
    ctx?: RoutingDecisionContext
  ): Promise<{
    selected: ModelMappingEntry | null
    reasonCode?: RoutingReasonCode
  }> {
    if (entries.length === 0) return { selected: null }
    if (entries.length === 1) return { selected: entries[0] }
    const selector = getRoutingStrategy(strategy)
    if (!selector) return { selected: entries[0], reasonCode: "strategy-unavailable" }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const selected = await Promise.race([
        Promise.resolve(
          selector.selectAsync
            ? selector.selectAsync(entries, this.telemetrySnapshot(), ctx)
            : selector.select(entries, this.telemetrySnapshot(), ctx)
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("routing-plugin-timeout")),
            this.config.pluginTimeoutMs ?? 250
          )
        }),
      ])
      if (
        selected &&
        entries.some(
          (entry) => entry.providerId === selected.providerId && entry.modelId === selected.modelId
        )
      ) {
        return { selected }
      }
      return { selected: entries[0], reasonCode: "plugin-error" }
    } catch (error) {
      return {
        selected: entries[0],
        reasonCode:
          error instanceof Error && error.message === "routing-plugin-timeout"
            ? "plugin-timeout"
            : "plugin-error",
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private applyHardConstraints(
    entries: readonly ModelMappingEntry[],
    request: RoutingRequest
  ): {
    candidates: ModelMappingEntry[]
    rejected: Map<RoutingReasonCode, number>
  } {
    const rejected = new Map<RoutingReasonCode, number>()
    const reject = (reasonCode: RoutingReasonCode) =>
      rejected.set(reasonCode, (rejected.get(reasonCode) ?? 0) + 1)
    const allowed = request.dataPolicy?.allowedProviderIds
      ? new Set(request.dataPolicy.allowedProviderIds)
      : undefined
    const excluded = new Set(request.dataPolicy?.excludedProviderIds ?? [])
    const requiredContext = Math.max(
      request.estimatedInputTokens ?? 0,
      request.requirements?.minContextTokens ?? 0
    )

    const candidates = entries.filter((entry) => {
      if (
        (allowed && !allowed.has(entry.providerId)) ||
        excluded.has(entry.providerId) ||
        (request.dataPolicy?.locality === "local-only" &&
          !this.deps.isLocalProvider?.(entry.providerId))
      ) {
        reject("data-policy")
        return false
      }

      const requirements = request.requirements
      if (!requirements) return true
      const capabilities = this.deps.getCapabilities?.(entry.providerId, entry.modelId)
      const requiredFlags: Array<[keyof RoutingCandidateCapabilities, boolean | undefined]> = [
        ["tools", requirements.tools],
        ["vision", requirements.vision],
        ["audio", requirements.audio],
        ["video", requirements.video],
        ["reasoning", requirements.reasoning],
        ["structuredOutput", requirements.structuredOutput],
        ["streaming", requirements.streaming],
      ]
      if (
        requiredFlags.some(
          ([capability, required]) => required === true && capabilities?.[capability] !== true
        )
      ) {
        reject("capability-required")
        return false
      }
      if (requiredContext > 0) {
        const contextTokens =
          capabilities?.contextTokens ??
          this.deps.getContextWindow?.(entry.providerId, entry.modelId)
        if (contextTokens === undefined || contextTokens < requiredContext) {
          reject("context-window")
          return false
        }
      }
      return true
    })
    return { candidates, rejected }
  }

  private dedupeEntries(entries: readonly ModelMappingEntry[]): ModelMappingEntry[] {
    const seen = new Set<string>()
    return entries.filter((entry) => {
      const key = `${entry.providerId}\0${entry.modelId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private toRouteCandidate(
    entry: ModelMappingEntry,
    reasonCodes: RoutingReasonCode[]
  ): RouteCandidate {
    return {
      ...entry,
      deploymentId: deploymentKeyOfEntry(entry) ?? `${entry.providerId}::${entry.modelId}`,
      reasonCodes: [...new Set(reasonCodes)],
    }
  }

  /** The read-only telemetry surface selectors score candidates with. */
  private telemetrySnapshot(): RoutingTelemetrySnapshot {
    return {
      getHealthMetrics: this.deps.getHealthMetrics,
      getPricing: this.deps.getPricing,
      getInFlight: this.deps.getInFlight ?? (() => 0),
      now: this.deps.now ?? (() => Date.now()),
      ...(this.deps.getDeploymentHealth
        ? { getDeploymentHealth: this.deps.getDeploymentHealth }
        : {}),
      ...(this.deps.getDeploymentInFlight
        ? { getDeploymentInFlight: this.deps.getDeploymentInFlight }
        : {}),
    }
  }
}
