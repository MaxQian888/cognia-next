// Domain types for the Strix security-scan plugin.

/** Strix vulnerability severity buckets (lower-cased). */
export type Severity = "critical" | "high" | "medium" | "low" | "info"

/** Ordered most-severe first — used for sorting + display. */
export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info"]

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
}

/** A normalized vulnerability finding (Dexie `findings` table, auto-`id`). */
export interface StrixFinding {
  id?: number
  runId: string
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
