/**
 * Pure analytics over the Anthropic subscription-quota snapshots
 * (`subscriptionUsage` rows parsed from `anthropic-ratelimit-unified-*`
 * headers). Kept side-effect-free and clock-injectable so the Usage tab's
 * trend chart, current-window gauges, and reset countdowns are all driven by
 * deterministic, testable functions.
 *
 * The renderer half lives in `components/settings/subscription/tabs/usage-tab.tsx`.
 */

import type {
  RepresentativeClaim,
  SubscriptionUsageRow,
  UsageStatus,
  UsageWindow,
} from "@/types/subscription"

/** Three-step severity for a utilization gauge. */
export type UsageLevel = "ok" | "warn" | "crit"

/** One point on the utilization trend chart. Values are whole percents (0-100). */
export interface UtilizationPoint {
  /** Snapshot wall-clock time (ms) — the x-axis. */
  at: number
  /** 5-hour window utilization as a percent, or `null` when the window was absent. */
  fiveHour: number | null
  /** 7-day window utilization as a percent, or `null` when the window was absent. */
  sevenDay: number | null
}

export interface BuildSeriesOptions {
  /** Injected clock for the range cutoff. Defaults to `Date.now()`. */
  now?: number
  /** Keep only points newer than `now - rangeMs`. `null`/omitted keeps all. */
  rangeMs?: number | null
}

const DAY_MS = 86_400_000

/**
 * Project snapshot rows into an ascending time series of 5h/7d utilization
 * percents. Rows may arrive newest-first (the live query reverses); this
 * always returns oldest-first so the chart reads left-to-right.
 */
export function buildUtilizationSeries(
  rows: readonly SubscriptionUsageRow[],
  options: BuildSeriesOptions = {}
): UtilizationPoint[] {
  const { now = Date.now(), rangeMs = null } = options
  const cutoff = rangeMs != null ? now - rangeMs : null
  const points: UtilizationPoint[] = []
  for (const row of rows) {
    if (cutoff != null && row.fetchedAt < cutoff) continue
    points.push({
      at: row.fetchedAt,
      fiveHour: row.fiveHour ? row.fiveHour.utilization * 100 : null,
      sevenDay: row.sevenDay ? row.sevenDay.utilization * 100 : null,
    })
  }
  points.sort((a, b) => a.at - b.at)
  return points
}

/** Resolved status for a single quota window. */
export interface WindowStatus {
  /** Utilization as a percent (0-100, may exceed 100 if the API reports so). */
  utilization: number
  level: UsageLevel
  /** Epoch ms when the window resets, or `null` when unreported. */
  resetAt: number | null
  /** Remaining ms until reset (clamped ≥ 0), or `null` when `resetAt` is absent. */
  msUntilReset: number | null
}

export interface CurrentWindowSummary {
  status: UsageStatus
  representativeClaim: RepresentativeClaim | null
  fallbackPercentage: number | null
  overageDisabledReason: string | null
  fiveHour: WindowStatus | null
  sevenDay: WindowStatus | null
}

export interface SummarizeOptions {
  now?: number
  /** Percent at/after which a window is flagged "warn". Default 90. */
  warnThresholdPct?: number
}

/**
 * Classify a utilization percent: `crit` once the window is fully consumed
 * (≥100%), `warn` at/after the warn threshold, else `ok`.
 */
export function levelForUtilizationPct(pct: number, warnThresholdPct: number): UsageLevel {
  if (pct >= 100) return "crit"
  if (pct >= warnThresholdPct) return "warn"
  return "ok"
}

function windowStatus(
  window: UsageWindow | null,
  now: number,
  warnThresholdPct: number
): WindowStatus | null {
  if (!window) return null
  const pct = window.utilization * 100
  const resetAt = Number.isFinite(window.resetAt) ? window.resetAt : null
  return {
    utilization: pct,
    level: levelForUtilizationPct(pct, warnThresholdPct),
    resetAt,
    msUntilReset: resetAt != null ? Math.max(0, resetAt - now) : null,
  }
}

/**
 * Distil the newest snapshot into the everything-at-a-glance shape the
 * current-window card renders. Returns `null` when there is no snapshot yet.
 */
export function summarizeCurrentWindow(
  latest: SubscriptionUsageRow | null | undefined,
  options: SummarizeOptions = {}
): CurrentWindowSummary | null {
  if (!latest) return null
  const { now = Date.now(), warnThresholdPct = 90 } = options
  return {
    status: latest.status,
    representativeClaim: latest.representativeClaim,
    fallbackPercentage: latest.fallbackPercentage,
    overageDisabledReason: latest.overageDisabledReason,
    fiveHour: windowStatus(latest.fiveHour, now, warnThresholdPct),
    sevenDay: windowStatus(latest.sevenDay, now, warnThresholdPct),
  }
}

/** Hours/minutes split of a countdown, with an `expired` flag for ms ≤ 0. */
export interface CountdownParts {
  expired: boolean
  hours: number
  minutes: number
}

/**
 * Split a remaining-ms countdown into whole hours + minutes for i18n-friendly
 * rendering (the UI composes the label from `countdown.*` keys, so this pure
 * helper never returns user-facing words). `expired` is `true` at/under 0.
 */
export function splitCountdown(ms: number): CountdownParts {
  if (!Number.isFinite(ms) || ms <= 0) return { expired: true, hours: 0, minutes: 0 }
  const totalMinutes = Math.floor(ms / 60_000)
  return {
    expired: false,
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  }
}

export { DAY_MS }
