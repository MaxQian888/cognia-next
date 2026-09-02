// Formatting for `UsageGlanceSnapshotV1`. One module, so the menu-bar title,
// the tray tooltip, the quick panel headline, the Capacity Dock row and the
// CLI footer cannot render the same snapshot differently.
//
// The rule that shapes all of it: a total is only a total when every turn in
// it was priceable. Otherwise the surface must say so, either with a dash
// (nothing known) or a lower bound (some known). Rendering "$4.20" over a
// window that also contains six unpriced turns is the specific lie this
// module exists to make impossible.

import { formatCompactTokens, formatCompactUsd } from "./status-snapshot"
import { UNKNOWN_COST } from "./session-analytics"
import type { UsageGlanceMetric, UsageGlancePeriod, UsageGlanceSnapshotV1 } from "./usage-glance"

export { UNKNOWN_COST }

/** Short suffix a taskbar readout appends, CodeBurn-style ("$4.20 / wk"). */
export const PERIOD_SUFFIX: Record<UsageGlancePeriod, string> = {
  today: "d",
  "7d": "wk",
  "30d": "30d",
  month: "mo",
  "90d": "90d",
}

/** i18n leaf under `tray.usage.period.*` / `usageGlance.period.*`. */
export const PERIOD_LABEL_KEYS: Record<UsageGlancePeriod, string> = {
  today: "today",
  "7d": "week",
  "30d": "month30",
  month: "calendarMonth",
  "90d": "quarter",
}

/**
 * How confident a money figure is.
 *
 * `exact` when every turn priced, `lowerBound` when some did and some did not,
 * `unknown` when none did. The three render differently on purpose.
 */
export type CostConfidence = "exact" | "lowerBound" | "unknown"

export function costConfidence(snapshot: UsageGlanceSnapshotV1): CostConfidence {
  if (snapshot.unpricedTurns === 0) return "exact"
  return snapshot.turns > snapshot.unpricedTurns ? "lowerBound" : "unknown"
}

/**
 * The money figure as text. `unknown` renders the dash rather than $0.00,
 * because a model we cannot price and a model that is free are both zero and
 * conflating them understates spend silently.
 */
export function formatGlanceCost(snapshot: UsageGlanceSnapshotV1): string {
  const confidence = costConfidence(snapshot)
  if (confidence === "unknown") return UNKNOWN_COST
  const money = formatCompactUsd(snapshot.knownCostUsd)
  return confidence === "lowerBound" ? `≥${money}` : money
}

/** The token figure as text, compacted ("1.2M"). */
export function formatGlanceTokens(snapshot: UsageGlanceSnapshotV1): string {
  return formatCompactTokens(snapshot.billableTokens)
}

/** The quota figure as text ("42%"), or the dash when nothing is configured. */
export function formatGlanceQuota(snapshot: UsageGlanceSnapshotV1): string {
  const pct = snapshot.quota?.worstUsedPct
  if (pct == null || !Number.isFinite(pct)) return UNKNOWN_COST
  return `${Math.max(0, Math.round(pct))}%`
}

/** The budget figure as text ("78%"), or the dash when no budget is set. */
export function formatGlanceBudget(snapshot: UsageGlanceSnapshotV1): string {
  const ratio = snapshot.budget?.ratio
  if (ratio == null || !Number.isFinite(ratio)) return UNKNOWN_COST
  return `${Math.max(0, Math.round(ratio * 100))}%`
}

/** The headline number for whichever metric a surface leads with. */
export function formatGlanceMetric(
  snapshot: UsageGlanceSnapshotV1,
  metric: UsageGlanceMetric = snapshot.query.metric
): string {
  switch (metric) {
    case "tokens":
      return formatGlanceTokens(snapshot)
    case "quota":
      return formatGlanceQuota(snapshot)
    case "budget":
      return formatGlanceBudget(snapshot)
    case "spend":
    default:
      return formatGlanceCost(snapshot)
  }
}

/**
 * The taskbar readout: the metric plus its window ("$4.20 / wk").
 *
 * `today` carries no suffix because a menu-bar figure with no window reads as
 * today everywhere this pattern exists, and the extra "/ d" is pure noise in
 * the tightest space on screen.
 */
export function formatTaskbarUsage(
  snapshot: UsageGlanceSnapshotV1,
  metric: UsageGlanceMetric = snapshot.query.metric
): string | null {
  const text = formatGlanceMetric(snapshot, metric)
  if (text === UNKNOWN_COST) return null
  if (snapshot.query.period === "today") return text
  return `${text} / ${PERIOD_SUFFIX[snapshot.query.period]}`
}

/**
 * Severity of the headline, driving the badge / dot color. Derived from the
 * budget when one is set (that is the number with a threshold), else from the
 * quota, else neutral.
 */
export type GlanceSeverity = "ok" | "warn" | "crit" | "exceeded" | "unknown"

export function glanceSeverity(snapshot: UsageGlanceSnapshotV1): GlanceSeverity {
  const budget = snapshot.budget
  if (budget?.blocked) return "exceeded"
  const quotaPct = snapshot.quota?.worstUsedPct
  const ratio = budget?.ratio ?? (typeof quotaPct === "number" ? quotaPct / 100 : null)
  if (ratio == null || !Number.isFinite(ratio)) return "unknown"
  if (ratio >= 1) return "exceeded"
  if (ratio >= 0.95) return "crit"
  if (ratio >= 0.8) return "warn"
  return "ok"
}

/**
 * i18n leaf under `usageGlance.freshness.*` for the disclosure row. A surface
 * that shows numbers must also be able to say how complete they are.
 */
export function freshnessLabelKey(snapshot: UsageGlanceSnapshotV1): string {
  return snapshot.freshness
}

/** Sparkline series, newest last, padded to `points` days with zeros. */
export function sparklineSeries(
  snapshot: UsageGlanceSnapshotV1,
  points = 7,
  metric: "spend" | "tokens" = "spend"
): number[] {
  const tail = snapshot.daily.slice(-points)
  const values = tail.map((b) => (metric === "tokens" ? b.tokens : b.knownCostUsd))
  const pad = Math.max(0, points - values.length)
  return [...Array<number>(pad).fill(0), ...values]
}
