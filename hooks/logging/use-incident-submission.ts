"use client"

/**
 * What makes the `/logs` consent panel do something.
 *
 * The panel shipped with two working checkboxes, a description box, and no way
 * to send anything: the checkboxes were local state nothing read, the textarea
 * was uncontrolled, and there was no submit button at all — while the copy
 * beside it said "Nothing is uploaded until you review the redacted report and
 * explicitly submit it".
 *
 * Two runtimes, two paths, one contract:
 *
 *   - **Desktop** packages natively (`crash::submit`) because the WebView can
 *     neither read the crash directory nor carry a gigabyte-scale package, and
 *     mints its grant from the installation key that also signs the package.
 *   - **Mobile** has no native packaging, so it uploads the plugin's redacted
 *     report as an `events` part through the ordinary client, and writes the
 *     receipt back through `markReceipt` — the plugin call that had existed
 *     with no production caller since it was written.
 */

import { useCallback, useMemo, useState } from "react"

import { readMobileCrashReport, recordMobileCrashReceipt } from "@/lib/capacitor/crash-diagnostics"
import { DiagnosticServiceClient, type DiagnosticFetch } from "@/lib/diagnostic-service/client"
import type { StoredDiagnosticConnection } from "@/lib/diagnostic-service/connection"
import {
  exchangeAnonymousGrant,
  loadOrCreateInstallationIdentity,
  type InstallationIdentity,
} from "@/lib/diagnostic-service/installation-identity"
import {
  canSubmitDiagnostics,
  deleteSubmission,
  refreshSubmission,
  submitCrashReport,
  withdrawSubmission,
  type DiagnosticConnectionInput,
} from "@/lib/native/diagnostic-submit"
import { createPlatformFetch } from "@/lib/network/platform-fetch"

import type { DiagnosticIncidentSummary } from "./use-diagnostic-incidents"

/** Mirrors `IncidentConsent` in the workspace component. */
export interface IncidentConsentInput {
  includeMinidump: boolean
  includeScreenshot: boolean
  description: string
}

export interface SubmissionOutcomeSummary {
  uploadedParts: number
  resumedParts: number
  screenshotUnavailable: boolean
}

/** Seams for the tests; production passes nothing. */
export interface IncidentSubmissionDeps {
  desktopSupported?: () => boolean
  submitDesktop?: typeof submitCrashReport
  refreshDesktop?: typeof refreshSubmission
  withdrawDesktop?: typeof withdrawSubmission
  deleteDesktop?: typeof deleteSubmission
  readMobile?: typeof readMobileCrashReport
  recordMobileReceipt?: typeof recordMobileCrashReceipt
  loadIdentity?: (accountId: string) => Promise<InstallationIdentity | null>
  exchangeGrant?: typeof exchangeAnonymousGrant
  fetchImpl?: DiagnosticFetch
  digest?: (bytes: Uint8Array) => Promise<string>
}

export interface UseIncidentSubmissionOptions {
  connection: StoredDiagnosticConnection | null
  accountId: string | null
  /** Re-read the incident list after anything changes. */
  onChanged: () => void | Promise<void>
  onConfigure: () => void
  deps?: IncidentSubmissionDeps
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * A failure this hook raised itself, carrying the code the panel translates.
 *
 * A bare `Error` would arrive at `codeOf` with its text in `message` and no
 * `code`, and be flattened into the generic failure — which is how a precise
 * "no service configured" turns into "the submission did not complete".
 */
class SubmissionCodeError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "SubmissionCodeError"
  }
}

/** Errors reach us as codes already; anything else becomes the generic one. */
function codeOf(cause: unknown): string {
  if (typeof cause === "string") return cause
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code: unknown }).code
    if (typeof code === "string") return code
  }
  return "submission_failed"
}

export function useIncidentSubmission(options: UseIncidentSubmissionOptions) {
  const { connection, accountId, onChanged, onConfigure, deps = {} } = options
  const [busy, setBusy] = useState(false)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [lastOutcome, setLastOutcome] = useState<SubmissionOutcomeSummary | null>(null)

  const desktopSupported = (deps.desktopSupported ?? canSubmitDiagnostics)()
  const fetchImpl = useMemo(() => deps.fetchImpl ?? createPlatformFetch(), [deps.fetchImpl])
  const digest = deps.digest ?? sha256Hex

  const nativeConnection: DiagnosticConnectionInput | null = useMemo(
    () =>
      connection
        ? {
            baseUrl: connection.baseUrl,
            tenantId: connection.tenantId,
            projectId: connection.projectId,
          }
        : null,
    [connection]
  )

  /**
   * Run one action, funnelling every failure into a stable code.
   *
   * The panel renders a translated string from the code and never the raw
   * message: service prose is neither localized nor guaranteed to be free of
   * detail a user should not have to read.
   */
  const run = useCallback(
    async (action: () => Promise<SubmissionOutcomeSummary | null>) => {
      setBusy(true)
      setErrorCode(null)
      try {
        const outcome = await action()
        setLastOutcome(outcome)
        await onChanged()
      } catch (cause) {
        setErrorCode(codeOf(cause))
      } finally {
        setBusy(false)
      }
    },
    [onChanged]
  )

  /**
   * Upload one mobile incident.
   *
   * The plugin hands back a redacted report object, not a package: there is no
   * native packager on mobile. It goes up as a single `events` part, which is
   * the kind whose frames the service extracts for grouping — the same reason
   * the desktop sends its events stream separately instead of one opaque blob.
   */
  const submitMobile = useCallback(
    async (
      incident: DiagnosticIncidentSummary,
      consent: IncidentConsentInput
    ): Promise<SubmissionOutcomeSummary> => {
      if (!connection || !accountId) throw new SubmissionCodeError("not_configured")
      const identity = await (deps.loadIdentity ?? loadOrCreateInstallationIdentity)(accountId)
      if (!identity) {
        // Honest capability report rather than an opaque signature failure:
        // this WebView is too old for Ed25519.
        throw new SubmissionCodeError("installation_proof_unsupported")
      }
      const grant = await (deps.exchangeGrant ?? exchangeAnonymousGrant)({
        baseUrl: connection.baseUrl,
        tenantId: connection.tenantId,
        projectId: connection.projectId,
        identity,
        fetchImpl,
      })
      const outcome = await (deps.readMobile ?? readMobileCrashReport)(incident.id)
      if (outcome.kind !== "ok") throw new SubmissionCodeError("report_not_found")
      const report = outcome.value

      const client = new DiagnosticServiceClient({
        baseUrl: connection.baseUrl,
        grant: () => Promise.resolve(grant.grant),
        fetchImpl,
      })
      const encoder = new TextEncoder()
      const parts: Array<{ bytes: Uint8Array; kind: "events" | "attachment" }> = [
        { bytes: encoder.encode(JSON.stringify(report)), kind: "events" },
      ]
      const description = consent.description.trim()
      if (description) {
        parts.push({ bytes: encoder.encode(description), kind: "attachment" })
      }

      const totalBytes = parts.reduce((sum, part) => sum + part.bytes.byteLength, 0)
      const created = await client.createIncident({
        // The report is the artifact; its hash is what makes a retry resume
        // rather than duplicate.
        artifactHash: await digest(parts[0].bytes),
        buildId: report.schemaVersion,
        platform: report.source,
        module: "cognia-mobile",
        exception: incident.source,
        attachmentCount: parts.length,
        eventCount: 1,
        totalBytes,
        largestAttachmentBytes: Math.max(...parts.map((part) => part.bytes.byteLength)),
        largestMinidumpBytes: 0,
        consent: true,
      })
      for (const [index, part] of parts.entries()) {
        await client.uploadPart(
          created.incident.id,
          index + 1,
          part.bytes,
          await digest(part.bytes),
          part.kind
        )
      }
      const receipt = await client.completeUpload(created.incident.id)
      // Writes the receipt back into the plugin's own store, which is what
      // makes the incident's state stop reading `detected` on next launch.
      await (deps.recordMobileReceipt ?? recordMobileCrashReceipt)(
        incident.id,
        receipt.supportCode,
        receipt.clientState
      )
      return {
        uploadedParts: parts.length,
        resumedParts: 0,
        // Mobile never offers one: the plugin's report is the whole artifact.
        screenshotUnavailable: false,
      }
    },
    [accountId, connection, deps, digest, fetchImpl]
  )

  const onSubmit = useCallback(
    (incident: DiagnosticIncidentSummary, consent: IncidentConsentInput) =>
      void run(async () => {
        if (!nativeConnection) throw new SubmissionCodeError("not_configured")
        if (incident.runtime === "mobile") return submitMobile(incident, consent)
        const outcome = await (deps.submitDesktop ?? submitCrashReport)(
          nativeConnection,
          incident.id,
          {
            includeMinidump: consent.includeMinidump,
            includeScreenshot: consent.includeScreenshot,
            description: consent.description.trim() || undefined,
          }
        )
        return {
          uploadedParts: outcome.uploadedParts,
          resumedParts: outcome.resumedParts,
          screenshotUnavailable: outcome.screenshotUnavailable,
        }
      }),
    [deps, nativeConnection, run, submitMobile]
  )

  const onRefresh = useCallback(
    (incident: DiagnosticIncidentSummary) =>
      void run(async () => {
        if (!nativeConnection) throw new SubmissionCodeError("not_configured")
        await (deps.refreshDesktop ?? refreshSubmission)(nativeConnection, incident.id)
        return null
      }),
    [deps, nativeConnection, run]
  )

  const onWithdraw = useCallback(
    (incident: DiagnosticIncidentSummary) =>
      void run(async () => {
        if (!nativeConnection) throw new SubmissionCodeError("not_configured")
        await (deps.withdrawDesktop ?? withdrawSubmission)(nativeConnection, incident.id)
        return null
      }),
    [deps, nativeConnection, run]
  )

  const onDeleteRemote = useCallback(
    (incident: DiagnosticIncidentSummary) =>
      void run(async () => {
        if (!nativeConnection) throw new SubmissionCodeError("not_configured")
        await (deps.deleteDesktop ?? deleteSubmission)(nativeConnection, incident.id)
        return null
      }),
    [deps, nativeConnection, run]
  )

  return useMemo(
    () => ({
      supported: desktopSupported,
      configured: Boolean(connection),
      busy,
      errorCode,
      lastOutcome,
      onSubmit,
      onRefresh,
      onWithdraw,
      onDeleteRemote,
      onConfigure,
    }),
    [
      busy,
      connection,
      desktopSupported,
      errorCode,
      lastOutcome,
      onConfigure,
      onDeleteRemote,
      onRefresh,
      onSubmit,
      onWithdraw,
    ]
  )
}
