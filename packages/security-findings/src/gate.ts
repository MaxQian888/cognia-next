/**
 * The gate: a normalized report plus a policy → a process exit code.
 *
 * Exit codes are the contract with CI, so they are defined here rather than in
 * the CLI, and the desktop panel reads the same verdict — a scan cannot pass
 * on screen and fail in a pipeline.
 *
 *  - `0` clean under the configured policy
 *  - `1` the result cannot be trusted (an unreadable report). NOT a
 *        "findings found" code; it means the question was not answered.
 *  - `2` findings at or above the configured threshold
 *
 * The `1` / `2` split matters: a pipeline that treats every non-zero the same
 * loses the distinction between "your code has a critical" and "the scanner
 * broke", and only one of those is fixed by editing code.
 */

import { atOrAboveSeverity, countBySeverity } from "./severity"
import type { Severity } from "./severity"
import type { ScanReport, SecurityFinding } from "./types"

export type SecurityExitCode = 0 | 1 | 2

export type GateVerdict =
  | "clean"
  | "threshold-met"
  /** The report could not be parsed; no claim is made about the target. */
  | "inconclusive"

export interface GateOptions {
  /**
   * Lowest severity that fails the gate. Undefined means report-only: the exit
   * code never reflects findings.
   *
   * Deliberately not defaulted to a severity. A default threshold would make
   * `security report` start failing builds the day it is adopted, so opting in
   * is explicit — and the CLI says out loud when no threshold was given.
   */
  failOn?: Severity
  /** Count only findings absent from the baseline. */
  onlyNew?: boolean
  /** Fingerprints triaged as not-a-problem; counted but never blocking. */
  suppressed?: ReadonlySet<string>
  /** Baseline fingerprints, required for {@link onlyNew} to mean anything. */
  baseline?: ReadonlySet<string>
}

export interface GateResult {
  exitCode: SecurityExitCode
  verdict: GateVerdict
  /** Findings that caused a `2`, most severe first. */
  blocking: SecurityFinding[]
  counts: Readonly<Record<Severity, number>>
  /** Findings withheld from blocking by {@link GateOptions.suppressed}. */
  suppressed: SecurityFinding[]
  /**
   * Set when `onlyNew` was requested with no baseline.
   *
   * The gate then considers EVERY finding new rather than none, because the
   * alternative — treating an absent baseline as "everything is known" — turns
   * a missing file into a silent pass.
   */
  degradedReason?: "only-new-without-baseline"
}

export function evaluateGate(report: ScanReport, options: GateOptions = {}): GateResult {
  const suppressedSet = options.suppressed
  const suppressed = suppressedSet
    ? report.findings.filter((finding) => suppressedSet.has(finding.fingerprint))
    : []
  const counts = countBySeverity(report.findings.map((finding) => finding.severity))

  // Checked before any threshold logic: an unreadable report has no findings
  // to compare, and every policy would therefore call it clean.
  if (report.completeness === "unreadable") {
    return { exitCode: 1, verdict: "inconclusive", blocking: [], counts, suppressed }
  }

  const degraded = options.onlyNew === true && options.baseline === undefined
  const considered = report.findings.filter((finding) => {
    if (suppressedSet?.has(finding.fingerprint)) return false
    if (!options.onlyNew) return true
    // With no baseline, nothing is known — so nothing is filtered out.
    return degraded || !options.baseline?.has(finding.fingerprint)
  })

  const threshold = options.failOn
  const blocking = threshold
    ? considered.filter((finding) => atOrAboveSeverity(finding.severity, threshold))
    : []

  return {
    exitCode: blocking.length > 0 ? 2 : 0,
    verdict: blocking.length > 0 ? "threshold-met" : "clean",
    blocking,
    counts,
    suppressed,
    ...(degraded ? { degradedReason: "only-new-without-baseline" as const } : {}),
  }
}
