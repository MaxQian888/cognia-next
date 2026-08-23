/**
 * Comparing a scan against a baseline.
 *
 * The baseline is a set of fingerprints — normally read back out of a
 * previously exported SARIF log (see `baselineFingerprintsFromSarif`). Keeping
 * it as bare fingerprints rather than whole findings is deliberate: the
 * baseline answers exactly one question, "was this already known?", and
 * carrying stale severities and descriptions around invites reporting the old
 * reading of a finding instead of the current one.
 */

import type { ScanReport, SecurityFinding } from "./types"

/** SARIF 2.1.0 `baselineState` values, minus `updated` — see below. */
export type BaselineState = "new" | "unchanged" | "absent"

export interface BaselineComparison {
  /** Reported now, not in the baseline. */
  added: SecurityFinding[]
  /** Reported now and in the baseline. */
  unchanged: SecurityFinding[]
  /** In the baseline, not reported now. Empty when {@link absentKnown} is false. */
  absent: string[]
  /**
   * Whether {@link absent} can be trusted.
   *
   * False for an unreadable report. A scan that failed to produce a parseable
   * artifact reports no findings, and subtracting that from the baseline would
   * say every known vulnerability had been fixed — the most dangerous possible
   * reading of a scanner that simply broke.
   */
  absentKnown: boolean
}

/**
 * `updated` is not produced.
 *
 * SARIF distinguishes a finding whose details changed from one that did not,
 * but the fingerprint deliberately excludes everything that could change
 * without the vulnerability changing (severity, prose, line numbers), so this
 * package has no basis to claim `updated` and does not guess at it.
 */
export function compareToBaseline(
  report: ScanReport,
  baseline: ReadonlySet<string>
): BaselineComparison {
  const added: SecurityFinding[] = []
  const unchanged: SecurityFinding[] = []
  for (const finding of report.findings) {
    if (baseline.has(finding.fingerprint)) unchanged.push(finding)
    else added.push(finding)
  }
  const absentKnown = report.completeness !== "unreadable"
  const reported = new Set(report.findings.map((finding) => finding.fingerprint))
  return {
    added,
    unchanged,
    absent: absentKnown ? [...baseline].filter((fingerprint) => !reported.has(fingerprint)) : [],
    absentKnown,
  }
}

/** The baseline state of one finding, for SARIF emit. */
export function baselineStateOf(
  finding: SecurityFinding,
  baseline: ReadonlySet<string> | undefined
): BaselineState | undefined {
  // No baseline means no claim. Emitting `new` for every finding of a first
  // scan would make the next diff of that log meaningless.
  if (!baseline) return undefined
  return baseline.has(finding.fingerprint) ? "unchanged" : "new"
}
