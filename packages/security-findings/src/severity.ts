/**
 * Severity vocabulary, shared by every consumer of a scan report.
 *
 * Ordered most-severe first. `info` is the floor rather than a separate
 * "unknown" bucket on purpose: a scanner that emits a severity nobody
 * recognises must not silently become `critical` (which would block every
 * build) nor vanish from the report (which would hide a real finding).
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info"

export const SEVERITY_ORDER: readonly Severity[] = Object.freeze([
  "critical",
  "high",
  "medium",
  "low",
  "info",
])

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITY_ORDER as readonly string[]).includes(value)
}

/** 0 = critical … 4 = info. Sorting ascending puts the worst first. */
export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity)
}

/** Coerce an arbitrary scanner value to a known severity, defaulting to `info`. */
export function normalizeSeverity(value: unknown): Severity {
  const text = String(value ?? "")
    .toLowerCase()
    .trim()
  return isSeverity(text) ? text : "info"
}

/**
 * Whether `severity` is at least as severe as `threshold`.
 *
 * Note the direction: rank ASCENDS as severity falls, so "at or above the
 * threshold" is `rank <= thresholdRank`. Getting this backwards is the classic
 * way to build a gate that passes exactly the builds it should stop.
 */
export function atOrAboveSeverity(severity: Severity, threshold: Severity): boolean {
  return severityRank(severity) <= severityRank(threshold)
}

/** Count per severity, every bucket present so callers need no fallbacks. */
export function countBySeverity(
  severities: readonly Severity[]
): Readonly<Record<Severity, number>> {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const severity of severities) counts[severity] += 1
  return counts
}
