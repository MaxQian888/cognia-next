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

/**
 * How far out a reset is worth stating as a countdown. Past this, "resets in
 * 143h 12m" is arithmetic the reader has to redo — a weekday and clock time is
 * what they can actually plan around.
 */
const RESET_ABSOLUTE_THRESHOLD_MS = 24 * 60 * 60 * 1000

/**
 * How a window's reset should be phrased. Pure: the caller owns the i18n keys
 * and the locale-aware date formatting, this only decides which of the three
 * phrasings is honest for the distance involved.
 */
export type ResetDescriptor =
  /** Reset time unknown — the window reported none. */
  | { kind: "unknown" }
  /** At or past the reset instant; the provider has not rolled it over yet. */
  | { kind: "expired" }
  /** Near enough that a countdown is the useful form. */
  | { kind: "countdown"; hours: number; minutes: number }
  /** Far enough out that a wall-clock instant reads better. */
  | { kind: "absolute"; at: number }

export function describeReset(resetAt: number | null | undefined, now: number): ResetDescriptor {
  if (resetAt == null || !Number.isFinite(resetAt)) return { kind: "unknown" }
  const remaining = resetAt - now
  if (remaining <= 0) return { kind: "expired" }
  if (remaining >= RESET_ABSOLUTE_THRESHOLD_MS) return { kind: "absolute", at: resetAt }
  const parts = splitCountdown(remaining)
  return { kind: "countdown", hours: parts.hours, minutes: parts.minutes }
}

/**
 * `anthropic-ratelimit-unified-fallback-percentage` as a whole percent.
 *
 * The header is a 0–1 fraction, like every other ratio in that family
 * (`*-utilization` reports `0.0184` for 1.84%), and the field name is the only
 * thing that suggests otherwise. Rendering it raw printed "0%" for a real 20%
 * fallback share. One helper so every surface reads the field the same way.
 */
export function fallbackPercentWhole(fraction: number | null | undefined): number | null {
  if (fraction == null || !Number.isFinite(fraction)) return null
  return Math.round(fraction * 100)
}

export { DAY_MS }
