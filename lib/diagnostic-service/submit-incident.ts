"use client"

/**
 * Submit one captured crash report, on whichever path this device has.
 *
 * The one funnel both senders go through: the `/logs` consent panel
 * (`useIncidentSubmission`) and automatic submission (`auto-submit.ts`). Two
 * copies of the desktop/mobile branch would drift the first time either path
 * grew a field, and the consent panel is where a regression would be noticed —
 * automatic submission is the one nobody watches.
 *
 *   - **Desktop** packages natively (`crash::submit`): the WebView can neither
 *     read the crash directory nor carry a gigabyte-scale package, and the
 *     grant comes from the installation key that also signs the package.
 *   - **Mobile** uploads the Capacitor plugin's redacted report through the
 *     ordinary client (`submitMobileCrashReport`), which also writes the
 *     receipt back into the plugin's store.
 */

import {
  submitCrashReport,
  type DiagnosticConnectionInput,
  type SubmissionConsentInput,
} from "@/lib/native/diagnostic-submit"

import type { DiagnosticFetch } from "./client"
import type { StoredDiagnosticConnection } from "./connection"
import {
  SubmissionCodeError,
  submitMobileCrashReport,
  type MobileSubmitDeps,
} from "./mobile-submit"

/** The fields of a listed incident that submission needs. */
export interface SubmittableIncident {
  /** Report stem on the desktop, the plugin's incident id on mobile. */
  id: string
  runtime: "desktop" | "mobile"
  /** Capture source (`panic`, `native`, `ios-kscrash`, …), sent as the exception label. */
  source: string
}

/** The consent decisions, as the preview collected them. */
export interface IncidentConsentDecision {
  includeMinidump: boolean
  includeScreenshot: boolean
  /** Free text; blank means "no description" on both paths. */
  description: string
}

/**
 * The consent automatic submission uses: the report itself and nothing
 * optional. ADR-0102 lets a user skip the per-report preview, never widen what
 * is sent without asking — a minidump can hold process memory and a
 * screenshot is the user's screen right now.
 */
export const DEFAULT_SUBMISSION_CONSENT: Readonly<IncidentConsentDecision> = Object.freeze({
  includeMinidump: false,
  includeScreenshot: false,
  description: "",
})

export interface SubmitIncidentResult {
  uploadedParts: number
  resumedParts: number
  screenshotUnavailable: boolean
  /** The code a user quotes to support; the visible receipt. */
  supportCode: string
  /** The service's `incident_state` after completion. */
  clientState: string
}

export interface SubmitIncidentInput {
  connection: StoredDiagnosticConnection
  /** Required on mobile, whose grant comes from the account's installation identity. */
  accountId: string | null
  incident: SubmittableIncident
  consent: IncidentConsentDecision
  fetchImpl: DiagnosticFetch
}

/** Seams for the tests; production passes nothing. */
export interface SubmitIncidentDeps extends MobileSubmitDeps {
  submitDesktop?: typeof submitCrashReport
}

/** The connection facts the native side takes. */
export function toNativeConnection(
  connection: Pick<StoredDiagnosticConnection, "baseUrl" | "tenantId" | "projectId">
): DiagnosticConnectionInput {
  return {
    baseUrl: connection.baseUrl,
    tenantId: connection.tenantId,
    projectId: connection.projectId,
  }
}

/**
 * Send one report. Rejects with a coded error (`SubmissionCodeError` here,
 * `DiagnosticSubmitError` from the native bridge, `DiagnosticServiceError`
 * from the client), each carrying a `code` the caller translates.
 */
export async function submitIncidentReport(
  input: SubmitIncidentInput,
  deps: SubmitIncidentDeps = {}
): Promise<SubmitIncidentResult> {
  const { connection, accountId, incident, consent, fetchImpl } = input
  if (incident.runtime === "mobile") {
    if (!accountId) throw new SubmissionCodeError("not_configured")
    return submitMobileCrashReport(
      {
        connection,
        accountId,
        incidentId: incident.id,
        exception: incident.source,
        description: consent.description,
        fetchImpl,
      },
      deps
    )
  }
  const native: SubmissionConsentInput = {
    // A minidump is the one thing the panel can offer for a report that has
    // none; the native side refuses an absent file, so this stays the
    // caller's decision and is not second-guessed here.
    includeMinidump: consent.includeMinidump,
    includeScreenshot: consent.includeScreenshot,
    description: consent.description.trim() || undefined,
  }
  const outcome = await (deps.submitDesktop ?? submitCrashReport)(
    toNativeConnection(connection),
    incident.id,
    native
  )
  return {
    uploadedParts: outcome.uploadedParts,
    resumedParts: outcome.resumedParts,
    screenshotUnavailable: outcome.screenshotUnavailable,
    supportCode: outcome.supportCode,
    clientState: outcome.clientState,
  }
}
