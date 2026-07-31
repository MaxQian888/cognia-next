// Fuse the two Anthropic quota sources into one window list for the
// Subscription Overview / Usage surfaces:
//
//   • `providerLimits` snapshots — the FREE `GET /api/oauth/usage` endpoint
//     (fetched on demand, carries session/weekly/weekly_opus/weekly_sonnet
//     plus the pay-as-you-go overage meter).
//   • `subscriptionUsage` rows — passive `anthropic-ratelimit-*` header
//     samples from real chat traffic (plus the paid probe). Richer metadata
//     (unified status, representative claim, overage-disabled reason) but only
//     updates when a message is sent.
//
// Whichever snapshot is NEWER wins the window meters; header-only metadata is
// surfaced only when the header sample is the newer one (a stale claim is
// worse than none). Pure — trivially testable, no I/O.

import { deriveWindowStatus, windowMeter } from "../limits/meters"
import { summarizeCurrentWindow } from "./usage-analytics"

import type {
  LimitsMeter,
  LimitsMeterStatus,
  ProviderLimitsRow,
  RepresentativeClaim,
  SubscriptionUsageRow,
  UsageStatus,
} from "@/types/subscription"

/** Data considered fresh for this long; past it the UI auto-refreshes. */
export const USAGE_WINDOWS_STALE_MS = 5 * 60_000

export type UsageWindowsSource = "endpoint" | "headers"

export interface ResolvedUsageWindows {
  /** Which snapshot won, or `null` when both are absent. */
  source: UsageWindowsSource | null
  fetchedAt: number | null
  /** Ordered window meters (session, weekly, weekly_opus, weekly_sonnet, …). */
  windows: LimitsMeter[]
  /** Non-window meters from the endpoint (e.g. pay-as-you-go overage). */
  extras: LimitsMeter[]
  /** Max severity across the windows — drives the header status pill. */
  severity: LimitsMeterStatus
  /** Header-sample metadata; only set when the header sample is the winner. */
  headerStatus: UsageStatus | null
  representativeClaim: RepresentativeClaim | null
  overageDisabledReason: string | null
  fallbackPercentage: number | null
}

/**
 * Project the resolved snapshot onto the coarse `UsageStatus` vocabulary the
 * overview pill renders. The header sample's unified status wins when it's the
 * active source; otherwise the status is derived from meter severity.
 */
export function usageStatusFor(resolved: ResolvedUsageWindows): UsageStatus {
  if (resolved.headerStatus) return resolved.headerStatus
  switch (resolved.severity) {
    case "ok":
      return "allowed"
    case "warn":
      return "allowed_warning"
    case "crit":
    case "exceeded":
      return "rate_limited"
    default:
      return "unknown"
  }
}

const SEVERITY_ORDER: Record<LimitsMeterStatus, number> = {
  unknown: 0,
  ok: 1,
  warn: 2,
  crit: 3,
  exceeded: 4,
}

function maxSeverity(windows: LimitsMeter[]): LimitsMeterStatus {
  let worst: LimitsMeterStatus = "unknown"
  for (const m of windows) {
    if (SEVERITY_ORDER[m.status] > SEVERITY_ORDER[worst]) worst = m.status
  }
  return worst
}

const EMPTY: ResolvedUsageWindows = {
  source: null,
  fetchedAt: null,
  windows: [],
  extras: [],
  severity: "unknown",
  headerStatus: null,
  representativeClaim: null,
  overageDisabledReason: null,
  fallbackPercentage: null,
}

/**
 * Pick the newer of the two snapshots and normalize it into ordered
 * `LimitsMeter` windows. `warnThresholdPct` re-derives each window's status so
 * the user's configured warning threshold applies regardless of which source
 * produced the meter (persisted endpoint meters were derived with the default).
 */
export function resolveUsageWindows(
  limits: ProviderLimitsRow | null,
  headers: SubscriptionUsageRow | null,
  opts: { warnThresholdPct?: number } = {}
): ResolvedUsageWindows {
  const warnPct = opts.warnThresholdPct
  // An errored endpoint snapshot carries no meters — let headers win instead.
  const usableLimits = limits && !limits.error && limits.meters.length > 0 ? limits : null
  const endpointWins = !!usableLimits && (!headers || usableLimits.fetchedAt >= headers.fetchedAt)

  if (endpointWins) {
    const windows = usableLimits.meters
      .filter((m) => m.kind === "window")
      .map((m) =>
        m.usedPct == null || warnPct == null
          ? m
          : { ...m, status: deriveWindowStatus(m.usedPct, warnPct) }
      )
    const extras = usableLimits.meters.filter((m) => m.kind !== "window")
    return {
      source: "endpoint",
      fetchedAt: usableLimits.fetchedAt,
      windows,
      extras,
      severity: maxSeverity(windows),
      headerStatus: null,
      representativeClaim: null,
      overageDisabledReason: null,
      fallbackPercentage: null,
    }
  }

  if (headers) {
    // `summarizeCurrentWindow` converts the 0-1 header utilization to whole
    // percents and resolves reset countdowns; we only need the percents here.
    const summary = summarizeCurrentWindow(headers, { now: headers.fetchedAt })
    if (!summary) return EMPTY
    const windows: LimitsMeter[] = []
    if (summary.fiveHour) {
      windows.push(
        windowMeter(
          "session",
          "subscription.limits.meter.session",
          { utilization: summary.fiveHour.utilization, resetAt: summary.fiveHour.resetAt },
          warnPct
        )
      )
    }
    if (summary.sevenDay) {
      windows.push(
        windowMeter(
          "weekly",
          "subscription.limits.meter.weekly",
          { utilization: summary.sevenDay.utilization, resetAt: summary.sevenDay.resetAt },
          warnPct
        )
      )
    }
    return {
      source: "headers",
      fetchedAt: headers.fetchedAt,
      windows,
      extras: [],
      severity: maxSeverity(windows),
      headerStatus: summary.status,
      representativeClaim: summary.representativeClaim,
      overageDisabledReason: summary.overageDisabledReason,
      fallbackPercentage: summary.fallbackPercentage,
    }
  }

  return EMPTY
}

/** True when the resolved data is missing or older than the staleness budget. */
export function usageWindowsStale(
  resolved: Pick<ResolvedUsageWindows, "fetchedAt">,
  now: number,
  maxAgeMs: number = USAGE_WINDOWS_STALE_MS
): boolean {
  return resolved.fetchedAt == null || now - resolved.fetchedAt > maxAgeMs
}
