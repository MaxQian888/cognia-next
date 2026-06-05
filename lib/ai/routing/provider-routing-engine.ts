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
} from "@/types/provider/model-mapping"
import type { RoutingStrategy, RequestRoutingOverride } from "@/types/provider/auto-router"
import type {
  RoutingDecisionContext,
  RoutingStrategyId,
  RoutingTelemetrySnapshot,
} from "@/types/provider/routing-strategy"
import type { ProviderHealthMetrics } from "@/types/provider/health-metrics"
import type { CircuitBreakerStateValue } from "@/types/provider/circuit-breaker"
import type { ProviderName } from "@/types/provider"
import { resolveModelAlias, type ProviderHealthMetricsLite } from "./alias-resolver"
import { getRoutingStrategy } from "./strategy-registry"

/** Provider info needed for routing decisions */
export interface ProviderRoutingInfo {
  providerId: string
  modelId: string
  /** Known pricing per 1M prompt tokens (USD) */
  pricingPer1M?: number
}

/** Dependencies injected into the routing engine */
export interface RoutingEngineDeps {
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
export class ProviderRoutingEngine {
  constructor(
    private registry: ModelMappingRegistry,
    private config: RoutingConfig,
    private deps: RoutingEngineDeps
  ) {}

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
          options.promptText
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
   * Select the best entry from a resolved alias based on strategy
   */
  private selectFromEntries(
    entries: ModelMappingEntry[],
    strategy: RoutingStrategyId,
    alias: string,
    parameterDefaults?: AliasResolutionResult["parameterDefaults"],
    estimatedInputTokens?: number,
    promptText?: string
  ): RoutingResult | null {
    // Filter by circuit breaker and provider availability
    const available = entries.filter((e) => {
      const cbState = this.deps.getCircuitBreakerState(e.providerId)
      if (cbState === "open") return false
      return this.deps.isProviderAvailable(e.providerId)
    })

    if (available.length === 0) return null

    // Context-window pre-check (LiteLLM context_window_fallbacks): drop
    // entries whose usable window can't fit the estimated input. When NOTHING
    // fits, never dead-end — fall back to the largest-window entries (the
    // least likely to fail), bypassing the strategy (an over-window model is
    // going to fail anyway; window size dominates every other signal).
    let working = available
    let windowFallback = false
    const getWindow = this.deps.getContextWindow
    if (estimatedInputTokens !== undefined && getWindow) {
      const fits = available.filter(
        (e) => estimatedInputTokens <= getWindow(e.providerId, e.modelId)
      )
      if (fits.length > 0) {
        working = fits
      } else {
        working = [...available].sort(
          (a, b) => getWindow(b.providerId, b.modelId) - getWindow(a.providerId, a.modelId)
        )
        windowFallback = true
      }
    }

    // Filter by provider constraints (advisory: when every candidate is over
    // budget the original list survives, and the eventual selection carries an
    // overBudgetWarning instead of dead-ending the send).
    const { allowed, overBudget } = this.applyConstraints(working)
    const candidates = allowed.length > 0 ? allowed : working

    // Apply strategy-based selection (window-fallback keeps the window-desc
    // order instead).
    const selected = windowFallback
      ? candidates[0]
      : this.applyStrategy(candidates, strategy, { promptText, estimatedInputTokens })
    if (!selected) return null

    const fallbackEntries = candidates.filter(
      (e) => !(e.providerId === selected.providerId && e.modelId === selected.modelId)
    )

    const overBudgetWarning =
      allowed.length === 0
        ? overBudget.find((w) => w.providerId === selected.providerId)
        : undefined

    return {
      providerId: selected.providerId,
      modelId: selected.modelId,
      strategy,
      fromAlias: true,
      alias,
      fallbackEntries,
      parameterDefaults,
      reason: windowFallback
        ? `Estimated input exceeds every candidate's context window — picked the largest window from alias "${alias}"`
        : `Selected via ${strategy} strategy from alias "${alias}"`,
      ...(overBudgetWarning ? { overBudgetWarning } : {}),
    }
  }

  /**
   * Apply provider constraints. Over-budget entries are split out (not
   * silently dropped) so the caller can fall back to them with a warning when
   * nothing under budget remains.
   */
  private applyConstraints(entries: ModelMappingEntry[]): {
    allowed: ModelMappingEntry[]
    overBudget: Array<{ providerId: string; spend: number; budget: number }>
  } {
    if (this.config.providerConstraints.length === 0) {
      return { allowed: entries, overBudget: [] }
    }

    const allowed: ModelMappingEntry[] = []
    const overBudget: Array<{ providerId: string; spend: number; budget: number }> = []

    for (const entry of entries) {
      const constraint = this.config.providerConstraints.find(
        (c) => c.providerId === entry.providerId && c.enabled
      )
      if (!constraint) {
        allowed.push(entry) // No constraint = allowed
        continue
      }

      // RPM/TPM ceiling (trailing-minute window, reactive). A provider at its
      // configured rate is deprioritized — recovery is automatic within a
      // minute, so no warning rides along (unlike budgets).
      if (
        this.deps.getRate &&
        (constraint.maxRequestsPerMinute !== undefined ||
          constraint.maxTokensPerMinute !== undefined)
      ) {
        const rate = this.deps.getRate(entry.providerId)
        if (
          (constraint.maxRequestsPerMinute !== undefined &&
            rate.rpm >= constraint.maxRequestsPerMinute) ||
          (constraint.maxTokensPerMinute !== undefined && rate.tpm >= constraint.maxTokensPerMinute)
        ) {
          continue
        }
      }

      if (constraint.dailyCostBudget === undefined) {
        allowed.push(entry)
        continue
      }

      // Durable today-spend mirror first; fall back to the session-scoped
      // health-metrics total when the mirror isn't wired (older call sites).
      const spend =
        this.deps.getTodaySpend?.(entry.providerId) ??
        this.deps.getHealthMetrics(entry.providerId)?.totalCost ??
        0
      if (spend >= constraint.dailyCostBudget) {
        overBudget.push({
          providerId: entry.providerId,
          spend,
          budget: constraint.dailyCostBudget,
        })
      } else {
        allowed.push(entry)
      }
    }

    return { allowed, overBudget }
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

  /** The read-only telemetry surface selectors score candidates with. */
  private telemetrySnapshot(): RoutingTelemetrySnapshot {
    return {
      getHealthMetrics: this.deps.getHealthMetrics,
      getPricing: this.deps.getPricing,
      getInFlight: this.deps.getInFlight ?? (() => 0),
      now: this.deps.now ?? (() => Date.now()),
    }
  }
}
