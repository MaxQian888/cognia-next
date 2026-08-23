/** Canonical shapes a scan report is reduced to before anything consumes it. */

import type { Severity } from "./severity"

/** Where a finding lives. Every field optional — scanners vary wildly. */
export interface FindingLocation {
  /** Workspace-relative path when the scanner did white-box analysis. */
  file?: string
  startLine?: number
  endLine?: number
  /** URL path for a black-box (DAST) finding. */
  endpoint?: string
  /** HTTP method, upper-cased, when `endpoint` is set. */
  method?: string
}

/**
 * One normalized finding.
 *
 * `fingerprint` is the identity used everywhere downstream — baseline diffing,
 * triage state, suppression. It is derived, never taken from the scanner: a
 * scanner's own id is typically per-run and would make every finding "new" on
 * every scan.
 */
export interface SecurityFinding {
  fingerprint: string
  /** The vulnerability CLASS, stable across runs (e.g. `sql-injection`). */
  ruleId: string
  title: string
  severity: Severity
  cvss?: number
  description?: string
  remediation?: string
  cwe?: string
  cve?: string
  locations: FindingLocation[]
}

/**
 * How completely a report was read.
 *
 * `unreadable` exists because it must never collapse into `complete` with zero
 * findings. A scan whose report could not be parsed may have found criticals;
 * reporting it as clean is the single worst outcome this package can produce,
 * so it is a first-class state carried all the way to the process exit code.
 */
export type ReportCompleteness = "complete" | "empty" | "unreadable"

export interface ScanReport {
  /** Stable key for the scanned target — see `targetKey`. */
  target: string
  completeness: ReportCompleteness
  findings: SecurityFinding[]
  /** Set when `completeness === "unreadable"`; the parse failure, verbatim. */
  unreadableReason?: string
  /** Scanner name and version, when the artifact reported them. */
  tool?: { name: string; version?: string }
}
