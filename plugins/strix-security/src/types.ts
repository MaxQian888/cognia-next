// Domain types for the Strix security-scan plugin.
//
// Severity, fingerprinting and the report shapes that leave this plugin live
// in `@cognia/security-findings`, so the panel and the `cognia-agent security`
// CLI cannot disagree about what a finding is. The types here are the panel's
// RICHER view: proof-of-concept code, technical analysis and code snippets are
// deliberately not part of the shared canonical shape, because they are what
// this plugin exists to show and what an exported SARIF log has no business
// carrying into a CI log.

import type { Severity } from "@cognia/plugin-sdk/api/security-findings"
export type { Severity }

/** Ordered most-severe first — used for sorting + display. */
export { SEVERITY_ORDER } from "@cognia/plugin-sdk/api/security-findings"

/** Lifecycle status of a scan run. */
export type RunStatus = "running" | "done" | "error" | "cancelled"

/** User-supplied options for a single scan. */
export interface ScanOptions {
  /** Target URL or local path passed to `strix --target`. */
  target: string
  /** Optional STRIX_LLM model override (persisted as a pref). */
  model?: string
  /** Optional per-session LLM_API_KEY override — passed via env, never persisted. */
  apiKey?: string
}

/** One code location attached to a finding (white-box results). */
export interface CodeLocation {
  file?: string
  startLine?: number
  endLine?: number
  snippet?: string
  label?: string
}

/** A scan run record (Dexie `runs` table, keyed by `runId`). */
export interface StrixRun {
  runId: string
  target: string
  model?: string
  startedAt: number
  endedAt?: number
  status: RunStatus
  /** Process exit code: 0 clean, 2 vulns found, 1 error, null if unknown. */
  exitCode?: number | null
  findingsCount: number
  /** Timestamp the user acknowledged authorization for this target. */
  authorizedAt: number
  /** Populated when status === "error". */
  error?: string
  /**
   * The vulnerability report was produced but could not be parsed.
   *
   * A durable flag rather than a substring of {@link error}: everything
   * downstream — the SARIF invocation, the CLI exit code — has to distinguish
   * "the scan failed" from "the scan may have found criticals and we cannot
   * tell", and matching on a human-readable message to decide that would break
   * the first time the wording changed.
   */
  reportUnreadable?: boolean
}

/** A normalized vulnerability finding (Dexie `findings` table, auto-`id`). */
export interface StrixFinding {
  id?: number
  runId: string
  /**
   * Stable identity across scans — see `@cognia/security-findings`.
   *
   * `vulnId` below is Strix's own per-run id and is NOT identity: keying on it
   * makes every finding new on every scan, so a triage decision would never
   * survive a rescan. Absent on rows written before fingerprinting existed;
   * those simply cannot be triaged until their target is rescanned.
   */
  fingerprint?: string
  /** The vulnerability CLASS, for suppression rules. Absent on legacy rows. */
  ruleId?: string
  vulnId: string
  title: string
  severity: Severity
  cvss?: number
  description?: string
  impact?: string
  target?: string
  technicalAnalysis?: string
  pocDescription?: string
  pocScriptCode?: string
  remediationSteps?: string
  cwe?: string
  cve?: string
  endpoint?: string
  method?: string
  codeLocations?: CodeLocation[]
}

/**
 * A human's verdict on one finding.
 *
 * `fixed` deliberately does NOT suppress. If a finding marked fixed is still
 * being reported, that contradiction is worth showing, not hiding — only
 * `accepted` (risk taken knowingly) and `false-positive` (not a real finding)
 * withhold it from the gate.
 */
export type FindingState = "open" | "accepted" | "false-positive" | "fixed"

/** Every value {@link FindingState} can take, for label coverage. */
export const FINDING_STATES: readonly FindingState[] = Object.freeze([
  "open",
  "accepted",
  "false-positive",
  "fixed",
])

/** The states that withhold a finding from the gate. */
export const SUPPRESSING_STATES: readonly FindingState[] = Object.freeze([
  "accepted",
  "false-positive",
])

/** A triage decision (Dexie `findingStates` table, keyed `<target> <fingerprint>`). */
export interface FindingStateRow {
  key: string
  target: string
  fingerprint: string
  state: FindingState
  note?: string
  updatedAt: number
}

/**
 * A whole vulnerability class muted for one target.
 *
 * Distinct from a per-finding state: a rule suppression also covers findings
 * of that class this target has not reported YET, which is the point — a
 * known-and-accepted class should not re-open a triage task every time the
 * scanner discovers another instance of it.
 */
export interface SuppressionRule {
  /** `<target>::<ruleId>`. */
  id: string
  target: string
  ruleId: string
  reason?: string
  createdAt: number
}

/** Result of the pre-scan environment check. */
export interface PreflightStatus {
  /** Docker daemon reachable. */
  docker: boolean
  /** `strix` binary found on PATH. */
  strix: boolean
  /** Parsed `strix --version`, when available. */
  strixVersion?: string
  checkedAt: number
}
