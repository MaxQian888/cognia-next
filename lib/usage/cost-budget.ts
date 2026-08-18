/**
 * Tiered USD cost budget — the policy half.
 *
 * Everything here is pure: a policy plus a spend snapshot yields verdicts. The
 * side effects (reading Dexie, notifying, opening the HITL gate) belong to the
 * governor and the runtime, so the rules themselves can be tested exhaustively
 * without a database.
 *
 * ## Why USD and not tokens
 *
 * The existing budget authority counts TOKENS
 * (`lib/ai/agent/team/budget-guard.ts`). Tokens are the wrong unit for a
 * spending limit: the same 100k tokens cost $0 on a local model, $0.30 on Haiku
 * and $2.50 on Opus, so a token cap either strangles cheap work or fails to
 * stop expensive work. This layer caps the thing the user actually cares about.
 *
 * ## Scopes
 *
 * Four independent scopes, any subset configured: day/month × global/per-provider.
 * They are independent on purpose — a per-provider daily cap is how you stop one
 * misbehaving provider without lowering the ceiling for everything else, and a
 * monthly cap is what maps to how these services actually bill.
 */

/** Rolling window a limit applies to. */
export type CostBudgetPeriod = "day" | "month"

/** What a limit is scoped to: everything, or one provider. */
export const GLOBAL_BUDGET_TARGET = "*"

export interface CostBudgetPolicy {
  /** Ceiling for all spend today. Absent or <= 0 means no limit. */
  dailyUsd?: number
  /** Ceiling for all spend this calendar month. */
  monthlyUsd?: number
  /** Per-provider daily ceilings, keyed by provider id. */
  perProviderDailyUsd?: Record<string, number>
  /** Per-provider monthly ceilings, keyed by provider id. */
  perProviderMonthlyUsd?: Record<string, number>
  /** Warning ratio (0–1). Default 0.80. */
  warnAt?: number
  /** Critical ratio (0–1). Default 0.95. */
  criticalAt?: number
}

/** Observed spend, as read from the durable rollup. */
export interface CostBudgetSpend {
  /** All providers, today. */
  dayUsd: number
  /** All providers, this calendar month. */
  monthUsd: number
  /** Today's spend per provider. */
  byProviderDayUsd?: Record<string, number>
  /** This month's spend per provider. */
  byProviderMonthUsd?: Record<string, number>
}

export type CostBudgetLevel = "ok" | "warning" | "critical" | "exceeded"

export interface CostBudgetVerdict {
  /** Stable key for dedupe, override grants and gate ids. */
  scopeKey: string
  period: CostBudgetPeriod
  /** Provider id, or {@link GLOBAL_BUDGET_TARGET}. */
  target: string
  usedUsd: number
  limitUsd: number
  /** `usedUsd / limitUsd`, uncapped so an overshoot is visible. */
  ratio: number
  level: CostBudgetLevel
}

export const DEFAULT_WARN_AT = 0.8
export const DEFAULT_CRITICAL_AT = 0.95

/** Rank used to pick the single worst verdict across scopes. */
const LEVEL_RANK: Record<CostBudgetLevel, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
  exceeded: 3,
}

/** `day:*`, `month:anthropic`, … */
export function budgetScopeKey(period: CostBudgetPeriod, target: string): string {
  return `${period}:${target}`
}

function usableLimit(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

function levelFor(ratio: number, warnAt: number, criticalAt: number): CostBudgetLevel {
  if (ratio >= 1) return "exceeded"
  if (ratio >= criticalAt) return "critical"
  if (ratio >= warnAt) return "warning"
  return "ok"
}

/**
 * Evaluate every configured scope.
 *
 * When `providerId` is given, per-provider scopes are evaluated only for that
 * provider — the caller is asking "may THIS provider spend?", and other
 * providers' caps have no bearing on that. With no provider, every configured
 * per-provider scope is evaluated, which is what a dashboard wants.
 */
export function evaluateCostBudget(
  policy: CostBudgetPolicy,
  spend: CostBudgetSpend,
  providerId?: string
): CostBudgetVerdict[] {
  const warnAt = clampRatio(policy.warnAt, DEFAULT_WARN_AT)
  const criticalAt = clampRatio(policy.criticalAt, DEFAULT_CRITICAL_AT)
  const out: CostBudgetVerdict[] = []

  const push = (period: CostBudgetPeriod, target: string, used: number, limit: number): void => {
    const ratio = used / limit
    out.push({
      scopeKey: budgetScopeKey(period, target),
      period,
      target,
      usedUsd: used,
      limitUsd: limit,
      ratio,
      level: levelFor(ratio, warnAt, criticalAt),
    })
  }

  const dailyLimit = usableLimit(policy.dailyUsd)
  if (dailyLimit !== null) push("day", GLOBAL_BUDGET_TARGET, num(spend.dayUsd), dailyLimit)

  const monthlyLimit = usableLimit(policy.monthlyUsd)
  if (monthlyLimit !== null) push("month", GLOBAL_BUDGET_TARGET, num(spend.monthUsd), monthlyLimit)

  for (const [period, limits, byProvider] of [
    ["day", policy.perProviderDailyUsd, spend.byProviderDayUsd],
    ["month", policy.perProviderMonthlyUsd, spend.byProviderMonthUsd],
  ] as const) {
    if (!limits) continue
    for (const [provider, rawLimit] of Object.entries(limits)) {
      if (providerId !== undefined && provider !== providerId) continue
      const limit = usableLimit(rawLimit)
      if (limit === null) continue
      push(period, provider, num(byProvider?.[provider]), limit)
    }
  }

  return out
}

/** The single most severe verdict, or `null` when no scope is configured. */
export function worstCostBudgetVerdict(
  verdicts: readonly CostBudgetVerdict[]
): CostBudgetVerdict | null {
  let worst: CostBudgetVerdict | null = null
  for (const verdict of verdicts) {
    if (!worst) {
      worst = verdict
      continue
    }
    if (LEVEL_RANK[verdict.level] > LEVEL_RANK[worst.level]) {
      worst = verdict
      continue
    }
    // Same severity: the closest to its ceiling is the more useful one to show.
    if (LEVEL_RANK[verdict.level] === LEVEL_RANK[worst.level] && verdict.ratio > worst.ratio) {
      worst = verdict
    }
  }
  return worst
}

/** Every scope at or past its ceiling — the ones that block a send. */
export function exceededScopes(verdicts: readonly CostBudgetVerdict[]): CostBudgetVerdict[] {
  return verdicts.filter((verdict) => verdict.level === "exceeded")
}

/** Human-facing percentage, e.g. `"97.4%"`. */
export function formatBudgetRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "0%"
  return `${(ratio * 100).toFixed(1)}%`
}

function clampRatio(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

function num(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}
