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
 *     report through the ordinary client (`submitMobileCrashReport`) and
 *     writes the receipt back through `markReceipt`. Which of the two this
 *     device has comes from `useDiagnosticSubmissionSupport`; `supported` used
 *     to be `isTauri()`, which told every phone to go find a desktop.
 *
 * Every piece of in-flight state is keyed by incident. It used to be three
 * hook-wide fields, so selecting report B while A was submitting showed B as
 * busy, and A's failure or outcome rendered under B.
 */

import { useCallback, useMemo, useState } from "react"

import {
  useDiagnosticSubmissionSupport,
  type DiagnosticSubmissionSupportDeps,
} from "@/hooks/diagnostic-service/use-diagnostic-submission-support"
import type { DiagnosticFetch } from "@/lib/diagnostic-service/client"
import type { StoredDiagnosticConnection } from "@/lib/diagnostic-service/connection"
import { SubmissionCodeError } from "@/lib/diagnostic-service/mobile-submit"
import {
  submitIncidentReport,
  toNativeConnection,
  type SubmitIncidentDeps,
} from "@/lib/diagnostic-service/submit-incident"
import {
  deleteSubmission,
  refreshSubmission,
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

/** One incident's submission state. */
export interface IncidentSubmissionState {
  /** A submit/refresh/withdraw/delete call is in flight for this incident. */
  busy: boolean
  /** Stable code from this incident's last failure, translated by the panel. */
  errorCode: string | null
  /** What this incident's last successful submission actually moved. */
  lastOutcome: SubmissionOutcomeSummary | null
}

export const IDLE_SUBMISSION_STATE: IncidentSubmissionState = Object.freeze({
  busy: false,
  errorCode: null,
  lastOutcome: null,
})

/**
 * The key submission state is held under. Runtime-qualified because a desktop
 * stem and a mobile incident id share no namespace.
 */
export function incidentSubmissionKey(
  incident: Pick<DiagnosticIncidentSummary, "id" | "runtime">
): string {
  return `${incident.runtime}:${incident.id}`
}

/** Seams for the tests; production passes nothing. */
export interface IncidentSubmissionDeps extends SubmitIncidentDeps {
  /** Synchronous desktop check (defaults to `canSubmitDiagnostics`). */
  desktopSupported?: () => boolean
  /** Asynchronous runtime probe (defaults to `resolveSubmissionRuntime`). */
  resolveRuntime?: DiagnosticSubmissionSupportDeps["resolveRuntime"]
  refreshDesktop?: typeof refreshSubmission
  withdrawDesktop?: typeof withdrawSubmission
  deleteDesktop?: typeof deleteSubmission
  fetchImpl?: DiagnosticFetch
}

export interface UseIncidentSubmissionOptions {
  connection: StoredDiagnosticConnection | null
  accountId: string | null
  /** Re-read the incident list after anything changes. */
  onChanged: () => void | Promise<void>
  onConfigure: () => void
  deps?: IncidentSubmissionDeps
}

/**
 * What the `/logs` Crash reports channel needs in order to actually submit
 * something, per incident. `IncidentWorkspace` takes exactly this.
 */
export interface IncidentSubmissionApi {
  /** Whether this device has any submission path (desktop native, or the mobile plugin). */
  supported: boolean
  /** The mobile capability probe has not answered yet; `supported` is not final. */
  checkingSupport: boolean
  /** Whether a diagnostic service has been configured for this account. */
  configured: boolean
  /** One incident's state; idle for an incident nothing has been attempted on. */
  stateFor: (incident: Pick<DiagnosticIncidentSummary, "id" | "runtime">) => IncidentSubmissionState
  onSubmit: (incident: DiagnosticIncidentSummary, consent: IncidentConsentInput) => void
  onRefresh: (incident: DiagnosticIncidentSummary) => void
  onWithdraw: (incident: DiagnosticIncidentSummary) => void
  onDeleteRemote: (incident: DiagnosticIncidentSummary) => void
  /** Opens Settings → Diagnostics so an unconfigured user has somewhere to go. */
  onConfigure: () => void
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

export function useIncidentSubmission(
  options: UseIncidentSubmissionOptions
): IncidentSubmissionApi {
  const { connection, accountId, onChanged, onConfigure, deps = {} } = options
  const [states, setStates] = useState<Record<string, IncidentSubmissionState>>({})

  const support = useDiagnosticSubmissionSupport({
    isDesktop: deps.desktopSupported,
    resolveRuntime: deps.resolveRuntime,
  })
  const fetchImpl = useMemo(() => deps.fetchImpl ?? createPlatformFetch(), [deps.fetchImpl])

  const nativeConnection: DiagnosticConnectionInput | null = useMemo(
    () => (connection ? toNativeConnection(connection) : null),
    [connection]
  )

  const patch = useCallback((key: string, next: Partial<IncidentSubmissionState>) => {
    setStates((current) => ({
      ...current,
      [key]: { ...(current[key] ?? IDLE_SUBMISSION_STATE), ...next },
    }))
  }, [])

  /**
   * Run one action for one incident, funnelling every failure into a stable
   * code stored against that incident.
   *
   * The panel renders a translated string from the code and never the raw
   * message: service prose is neither localized nor guaranteed to be free of
   * detail a user should not have to read. A status-only action (refresh,
   * withdraw, delete) keeps the incident's previous outcome rather than
   * wiping the record of what its submission moved.
   */
  const run = useCallback(
    async (
      incident: DiagnosticIncidentSummary,
      action: () => Promise<SubmissionOutcomeSummary | null>
    ) => {
      const key = incidentSubmissionKey(incident)
      patch(key, { busy: true, errorCode: null })
      try {
        const outcome = await action()
        patch(key, outcome ? { busy: false, lastOutcome: outcome } : { busy: false })
        await onChanged()
      } catch (cause) {
        patch(key, { busy: false, errorCode: codeOf(cause) })
      }
    },
    [onChanged, patch]
  )

  const onSubmit = useCallback(
    (incident: DiagnosticIncidentSummary, consent: IncidentConsentInput) =>
      void run(incident, async () => {
        if (!connection) throw new SubmissionCodeError("not_configured")
        // The same funnel automatic submission uses, so the two paths cannot
        // drift on what a desktop or a mobile report sends.
        const result = await submitIncidentReport(
          { connection, accountId, incident, consent, fetchImpl },
          deps
        )
        return {
          uploadedParts: result.uploadedParts,
          resumedParts: result.resumedParts,
          screenshotUnavailable: result.screenshotUnavailable,
        }
      }),
    [accountId, connection, deps, fetchImpl, run]
  )

  /**
   * Refresh, withdraw and remote delete need the service's incident id, which
   * only the desktop's submissions sidecar keeps. A phone's receipt is its
   * support code alone, so these refuse with `desktop_only` there rather than
   * calling a native bridge that does not exist.
   */
  const remoteOnly = useCallback(
    (incident: DiagnosticIncidentSummary): DiagnosticConnectionInput => {
      if (incident.runtime === "mobile") throw new SubmissionCodeError("desktop_only")
      if (!nativeConnection) throw new SubmissionCodeError("not_configured")
      return nativeConnection
    },
    [nativeConnection]
  )

  const onRefresh = useCallback(
    (incident: DiagnosticIncidentSummary) =>
      void run(incident, async () => {
        await (deps.refreshDesktop ?? refreshSubmission)(remoteOnly(incident), incident.id)
        return null
      }),
    [deps, remoteOnly, run]
  )

  const onWithdraw = useCallback(
    (incident: DiagnosticIncidentSummary) =>
      void run(incident, async () => {
        await (deps.withdrawDesktop ?? withdrawSubmission)(remoteOnly(incident), incident.id)
        return null
      }),
    [deps, remoteOnly, run]
  )

  const onDeleteRemote = useCallback(
    (incident: DiagnosticIncidentSummary) =>
      void run(incident, async () => {
        await (deps.deleteDesktop ?? deleteSubmission)(remoteOnly(incident), incident.id)
        return null
      }),
    [deps, remoteOnly, run]
  )

  /** This incident's state; idle for one nothing has been attempted on. */
  const stateFor = useCallback(
    (incident: Pick<DiagnosticIncidentSummary, "id" | "runtime">): IncidentSubmissionState =>
      states[incidentSubmissionKey(incident)] ?? IDLE_SUBMISSION_STATE,
    [states]
  )

  return useMemo<IncidentSubmissionApi>(
    () => ({
      supported: support.supported,
      checkingSupport: support.checking,
      configured: Boolean(connection),
      stateFor,
      onSubmit,
      onRefresh,
      onWithdraw,
      onDeleteRemote,
      onConfigure,
    }),
    [
      connection,
      onConfigure,
      onDeleteRemote,
      onRefresh,
      onSubmit,
      onWithdraw,
      stateFor,
      support.checking,
      support.supported,
    ]
  )
}
