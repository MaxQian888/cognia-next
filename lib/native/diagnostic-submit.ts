import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"

/**
 * Thin wrappers over the Rust `crash::submit` surface.
 *
 * Packaging and upload stay native: a package can reach a gigabyte, the WebView
 * cannot read the crash directory, and the desktop CSP would block a renderer
 * request to a user-configured host anyway. The renderer decides *whether* to
 * send and *what* to include; this is how it says so.
 *
 * Every function is a no-op off the desktop runtime, mirroring the style of
 * `crash-reports.ts` next door. The mobile shell has its own path through the
 * Capacitor crash plugin.
 */

/** Connection facts the native side needs. Resolved by the renderer. */
export interface DiagnosticConnectionInput {
  baseUrl: string
  tenantId: string
  projectId: string
}

/** The consent decisions the submission preview collected. */
export interface SubmissionConsentInput {
  /** Unchecked by default — a minidump can hold process memory. */
  includeMinidump: boolean
  /** Captured now, after consent. Never a crash-time frame. */
  includeScreenshot: boolean
  description?: string
}

/** What the desktop remembers about a report it submitted. */
export interface SubmissionRecord {
  incidentId: string
  supportCode: string
  /** Mirrors the service's `incident_state`, which is what `/logs` renders. */
  clientState: string
  processingState: string
  serviceUrl: string
  submittedAt: string
  /** Present only for the call that created the incident. */
  deletionCredential?: string
  withdrawnAt?: string
  includedMinidump: boolean
  includedScreenshot: boolean
}

export interface SubmissionOutcome extends SubmissionRecord {
  uploadedParts: number
  /** Parts the service already held — a resumed upload after a failure. */
  resumedParts: number
  /** A screenshot was asked for but the platform refused to capture one. */
  screenshotUnavailable: boolean
}

/**
 * A submission failure carrying the native side's stable code.
 *
 * The codes are the service's own (`ingest_disabled`, `unauthorized`,
 * `raw_minidump_access_disabled`, …) plus a few local ones, and the UI maps
 * them to translated strings — never showing raw service prose, which is
 * neither localized nor guaranteed to be free of detail a user should not read.
 */
export class DiagnosticSubmitError extends Error {
  readonly name = "DiagnosticSubmitError"

  constructor(readonly code: string) {
    super(code)
  }

  /** True when intake is off and the local report should be kept, not discarded. */
  get isIngestDisabled(): boolean {
    return this.code === "ingest_disabled"
  }

  get isUnavailable(): boolean {
    return this.code === "network_unavailable"
  }
}

/** Native errors arrive as a bare string; anything else is a bug in the bridge. */
function toSubmitError(cause: unknown): DiagnosticSubmitError {
  if (typeof cause === "string") return new DiagnosticSubmitError(cause)
  if (cause instanceof Error) return new DiagnosticSubmitError(cause.message)
  return new DiagnosticSubmitError("submission_failed")
}

/** Whether this shell can submit at all. */
export function canSubmitDiagnostics(): boolean {
  return isTauri()
}

export async function submitCrashReport(
  connection: DiagnosticConnectionInput,
  stem: string,
  consent: SubmissionConsentInput
): Promise<SubmissionOutcome> {
  if (!isTauri()) throw new DiagnosticSubmitError("desktop_only")
  try {
    return await invoke<SubmissionOutcome>("crash_submit_report", { connection, stem, consent })
  } catch (cause) {
    throw toSubmitError(cause)
  }
}

/**
 * Every stored submission record, keyed by report stem.
 *
 * Returns an empty map rather than throwing off-desktop or on a read failure:
 * the caller merges this into a report list, and a missing sidecar must not
 * take the list down with it.
 */
export async function listSubmissionRecords(): Promise<Record<string, SubmissionRecord>> {
  if (!isTauri()) return {}
  try {
    return await invoke<Record<string, SubmissionRecord>>("crash_submission_records")
  } catch {
    return {}
  }
}

export async function refreshSubmission(
  connection: DiagnosticConnectionInput,
  stem: string
): Promise<SubmissionRecord> {
  if (!isTauri()) throw new DiagnosticSubmitError("desktop_only")
  try {
    return await invoke<SubmissionRecord>("crash_refresh_submission", { connection, stem })
  } catch (cause) {
    throw toSubmitError(cause)
  }
}

/**
 * Withdraw consent for a submitted report.
 *
 * Distinct from deleting it: withdrawal blocks processing *and* schedules
 * removal, and it is the route that stays reachable while the service's intake
 * switch is off — the moment a withdrawal matters most.
 */
export async function withdrawSubmission(
  connection: DiagnosticConnectionInput,
  stem: string
): Promise<SubmissionRecord> {
  if (!isTauri()) throw new DiagnosticSubmitError("desktop_only")
  try {
    return await invoke<SubmissionRecord>("crash_withdraw_submission", { connection, stem })
  } catch (cause) {
    throw toSubmitError(cause)
  }
}

export async function deleteSubmission(
  connection: DiagnosticConnectionInput,
  stem: string
): Promise<void> {
  if (!isTauri()) throw new DiagnosticSubmitError("desktop_only")
  try {
    await invoke("crash_delete_submission", { connection, stem })
  } catch (cause) {
    throw toSubmitError(cause)
  }
}
