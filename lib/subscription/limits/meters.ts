// Shared meter-construction helpers for the unified limits sources. Pure: no
// I/O, clock injected by the caller. Reuses the Anthropic severity classifier
// so window severities match the desktop Usage tab exactly.

import { levelForUtilizationPct } from "@/lib/subscription/anthropic/usage-analytics"

import type {
  BalanceSnapshot,
  LimitsMeter,
  LimitsMeterStatus,
  LimitsSourceContext,
  ProviderLimits,
} from "@/types/subscription"

const WARN_PCT = 90

/**
 * Map a utilization percent to a meter status. Reuses the Anthropic ok/warn/crit
 * classifier (`crit` at ≥100) and adds the `exceeded` terminal for true overage
 * (>100%).
 */
export function deriveWindowStatus(pct: number, warnPct = WARN_PCT): LimitsMeterStatus {
  if (!Number.isFinite(pct)) return "unknown"
  if (pct > 100) return "exceeded"
  return levelForUtilizationPct(pct, warnPct)
}

/** Build a `window` meter from a resolved utilization + reset time. */
export function windowMeter(
  id: string,
  labelKey: string,
  win: { utilization: number; resetAt: number | null },
  warnPct = WARN_PCT
): LimitsMeter {
  const pct = Math.round(win.utilization)
  return {
    id,
    labelKey,
    kind: "window",
    usedPct: pct,
    resetAt: win.resetAt,
    status: deriveWindowStatus(win.utilization, warnPct),
  }
}

/**
 * Derive the used-percent for a balance meter when both endpoints are known:
 * prefer `used/total`, else `1 - remaining/total`. Returns `null` when it can't
 * be computed (credit-only providers that report just `remaining`).
 */
function balanceUsedPct(bal: BalanceSnapshot): number | null {
  if (typeof bal.total === "number" && bal.total > 0) {
    if (typeof bal.used === "number") return clampPct((bal.used / bal.total) * 100)
    if (typeof bal.remaining === "number") return clampPct((1 - bal.remaining / bal.total) * 100)
  }
  return null
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.round(n))
}

function statusForBalance(bal: BalanceSnapshot, usedPct: number | null): LimitsMeterStatus {
  if (typeof bal.remaining === "number" && bal.remaining <= 0) return "exceeded"
  if (usedPct != null) return deriveWindowStatus(usedPct)
  if (typeof bal.remaining === "number" && bal.remaining > 0) return "ok"
  return "unknown"
}

/** Project a `BalanceSnapshot` into a single `balance` meter. */
export function balanceMeter(bal: BalanceSnapshot): LimitsMeter {
  const usedPct = balanceUsedPct(bal)
  return {
    id: "credit",
    labelKey: "subscription.limits.meter.credit",
    kind: "balance",
    usedPct,
    used: bal.used,
    total: bal.total,
    remaining: bal.remaining,
    unit: bal.unit,
    currency: bal.currency,
    status: statusForBalance(bal, usedPct),
  }
}

/** A snapshot carrying just an `error` (no usable meters). */
export function errorLimits(
  ctx: Pick<LimitsSourceContext, "accountId" | "accountLabel" | "now">,
  provider: string,
  message: string
): ProviderLimits {
  return {
    provider,
    accountId: ctx.accountId,
    accountLabel: ctx.accountLabel,
    fetchedAt: ctx.now,
    meters: [],
    error: message,
  }
}
