/**
 * Built-in pre-call deployment filters. Each one extracts a check that used
 * to live inline in `ProviderRoutingEngine.selectFromEntries` /
 * `applyConstraints`, with IDENTICAL semantics — the engine regression suite
 * pins the behavior:
 *
 * - `circuit`        — drop entries whose breaker is open / provider disabled
 * - `context-window` — drop entries that can't fit the input; if NOTHING
 *                      fits, re-order by window desc + `windowFallback` note
 *                      (the engine bypasses the strategy on that note)
 * - `rate-limit`     — drop entries at their constraint's RPM/TPM ceiling;
 *                      advisory (keeps the input when it would empty the set)
 * - `budget`         — split out over-daily-budget entries; advisory (keeps
 *                      the input + `overBudget` note when all are over)
 */

import type {
  DeploymentCandidate,
  DeploymentFilter,
  FilterOutcome,
} from "@cognia/provider-types/deployment-filter"

export const circuitFilter: DeploymentFilter = {
  id: "circuit",
  label: "Circuit breaker",
  filter: (candidates, _req, ctx): FilterOutcome => ({
    candidates: candidates.filter((e) => {
      if (ctx.getCircuitBreakerState(e) === "open") return false
      return ctx.isAvailable(e)
    }),
  }),
}

export const contextWindowFilter: DeploymentFilter = {
  id: "context-window",
  label: "Context window",
  filter: (candidates, req, ctx): FilterOutcome => {
    const getWindow = ctx.getContextWindow
    const estimate = req.estimatedInputTokens
    if (estimate === undefined || !getWindow) return { candidates: [...candidates] }
    const fits = candidates.filter((e) => estimate <= getWindow(e.providerId, e.modelId))
    if (fits.length > 0) return { candidates: fits }
    // Nothing fits — never dead-end. Fall back to the largest-window entries
    // (the least likely to fail); window size dominates every other signal,
    // so the engine bypasses the strategy on this note.
    const sorted = [...candidates].sort(
      (a, b) => getWindow(b.providerId, b.modelId) - getWindow(a.providerId, a.modelId)
    )
    return { candidates: sorted, notes: { windowFallback: true } }
  },
}

export const rateLimitFilter: DeploymentFilter = {
  id: "rate-limit",
  label: "Rate limit",
  filter: (candidates, _req, ctx): FilterOutcome => {
    if (!ctx.getRate || ctx.constraints.length === 0) return { candidates: [...candidates] }
    const filtered = candidates.filter((e) => {
      const constraint = ctx.constraints.find((c) => c.providerId === e.providerId && c.enabled)
      if (
        !constraint ||
        (constraint.maxRequestsPerMinute === undefined &&
          constraint.maxTokensPerMinute === undefined)
      ) {
        return true
      }
      const rate = ctx.getRate!(e.providerId)
      return !(
        (constraint.maxRequestsPerMinute !== undefined &&
          rate.rpm >= constraint.maxRequestsPerMinute) ||
        (constraint.maxTokensPerMinute !== undefined && rate.tpm >= constraint.maxTokensPerMinute)
      )
    })
    // Advisory: a provider at its rate ceiling recovers within a minute, so
    // when EVERY candidate is rate-limited the original list survives.
    return { candidates: filtered.length > 0 ? filtered : [...candidates] }
  },
}

export const budgetFilter: DeploymentFilter = {
  id: "budget",
  label: "Daily budget",
  filter: (candidates, _req, ctx): FilterOutcome => {
    if (ctx.constraints.length === 0) return { candidates: [...candidates] }
    const allowed: DeploymentCandidate[] = []
    const overBudget: Array<{ providerId: string; spend: number; budget: number }> = []
    for (const e of candidates) {
      const constraint = ctx.constraints.find((c) => c.providerId === e.providerId && c.enabled)
      if (!constraint || constraint.dailyCostBudget === undefined) {
        allowed.push(e)
        continue
      }
      // Durable today-spend mirror first; fall back to the session-scoped
      // health-metrics total when the mirror isn't wired (older call sites).
      const spend =
        ctx.getTodaySpend?.(e.providerId) ??
        ctx.telemetry.getHealthMetrics(e.providerId)?.totalCost ??
        0
      if (spend >= constraint.dailyCostBudget) {
        overBudget.push({ providerId: e.providerId, spend, budget: constraint.dailyCostBudget })
      } else {
        allowed.push(e)
      }
    }
    if (allowed.length > 0) return { candidates: allowed }
    // Advisory budgets never dead-end a send: keep the original list and let
    // the engine attach the warning to whatever gets selected.
    return { candidates: [...candidates], notes: { overBudget } }
  },
}

export const BUILT_IN_DEPLOYMENT_FILTERS: ReadonlyArray<DeploymentFilter> = [
  circuitFilter,
  contextWindowFilter,
  rateLimitFilter,
  budgetFilter,
]
