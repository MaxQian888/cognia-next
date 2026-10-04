"use client"

/**
 * The crash reports this device captured, from whichever runtime it is.
 *
 * The desktop lists the Rust crash directory (panics and minidumps) joined with
 * its submissions sidecar; mobile lists the Capacitor crash plugin's store,
 * which carries the receipt `markReceipt` wrote. Every state is normalized onto
 * the service's `incident_state` vocabulary on the way in, so `/logs` filters
 * and labels one set of values whichever runtime produced them.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  deleteMobileCrashReport,
  listMobileCrashReports,
  readMobileCrashReport,
} from "@/lib/capacitor/crash-diagnostics"
import {
  deleteCrashReport,
  listCrashReports,
  readCrashReport,
  type CrashReportSummary,
} from "@/lib/native/crash-reports"
import {
  ACTIONABLE_INCIDENT_STATES,
  normalizeIncidentClientState,
  type IncidentClientState,
} from "@/lib/diagnostic-service/types"
import { listSubmissionRecords, type SubmissionRecord } from "@/lib/native/diagnostic-submit"
import type { MobileCrashSummary } from "@/lib/capacitor/crash-diagnostics"
import { isTauri } from "@/lib/tauri"

/** The two runtimes that capture crash reports. The plain browser captures none. */
export type IncidentRuntime = "desktop" | "mobile"

export interface DiagnosticIncidentSummary {
  id: string
  runtime: IncidentRuntime
  /**
   * How it was captured: `panic` / `native` on the desktop, the plugin's
   * collector (`android-acra`, `ios-kscrash`, …) on mobile, `unknown` for a
   * desktop report whose metadata could not be read.
   */
  source: string
  capturedAt: string
  /**
   * Position in the `incident_state` lifecycle.
   *
   * `detected` means captured locally and never sent. Anything beyond it comes
   * from a receipt: the mobile plugin stores one through `markReceipt`, and the
   * desktop stores one in its submissions sidecar. Before either was wired, the
   * desktop reported `detected` forever while the UI offered a lifecycle filter
   * that could never match.
   *
   * A value outside the vocabulary (a newer service, a hand-edited sidecar) is
   * kept as `detected` — the honest reading of "captured, no receipt we
   * understand" — rather than rendered as a raw string.
   */
  state: IncidentClientState
  /** The support code from the receipt, on either runtime. */
  receiptCode?: string
  sizeBytes: number
  artifacts: Array<"text" | "metadata" | "minidump" | "report">
  /**
   * The full desktop submission record, when this report has been sent from
   * the desktop. Mobile receipts carry only `receiptCode` and `state`: the
   * plugin stores no service incident id, so a phone cannot withdraw or delete
   * remotely (see `IncidentDetail`).
   */
  submission?: SubmissionRecord
}

/** Whether a report is still waiting on the user rather than on the service. */
export function isActionableIncident(incident: Pick<DiagnosticIncidentSummary, "state">): boolean {
  return ACTIONABLE_INCIDENT_STATES.includes(incident.state)
}

/**
 * How many reports are waiting on the user: captured, never sent, nothing on
 * the service's side yet. This is the number worth a badge — a report that has
 * a receipt is the service's to process, not the user's to act on.
 */
export function countActionableIncidents(
  incidents: readonly Pick<DiagnosticIncidentSummary, "state">[]
): number {
  return incidents.reduce((count, incident) => count + (isActionableIncident(incident) ? 1 : 0), 0)
}

type MobileListOutcome = Awaited<ReturnType<typeof listMobileCrashReports>>
type MobileReadOutcome = Awaited<ReturnType<typeof readMobileCrashReport>>
type MobileDeleteOutcome = Awaited<ReturnType<typeof deleteMobileCrashReport>>

export interface DiagnosticIncidentDependencies {
  /** Whether this shell is the desktop (Tauri) runtime. Defaults to `isTauri`. */
  isDesktop?: () => boolean
  listDesktop: () => Promise<CrashReportSummary[]>
  listSubmissions: () => Promise<Record<string, SubmissionRecord>>
  listMobile: () => Promise<MobileListOutcome>
  readDesktop: (id: string) => Promise<string | null>
  readMobile: (id: string) => Promise<MobileReadOutcome>
  deleteDesktop: (id: string) => Promise<boolean>
  deleteMobile: (id: string) => Promise<MobileDeleteOutcome>
}

const defaultDependencies: DiagnosticIncidentDependencies = {
  isDesktop: isTauri,
  listDesktop: listCrashReports,
  listSubmissions: listSubmissionRecords,
  listMobile: listMobileCrashReports,
  readDesktop: readCrashReport,
  readMobile: readMobileCrashReport,
  deleteDesktop: deleteCrashReport,
  deleteMobile: deleteMobileCrashReport,
}

function normalizeDesktop(
  report: CrashReportSummary,
  submission?: SubmissionRecord
): DiagnosticIncidentSummary {
  const artifacts: DiagnosticIncidentSummary["artifacts"] = []
  if (report.hasTxt) artifacts.push("text")
  if (report.hasJson) artifacts.push("metadata")
  if (report.hasDmp) artifacts.push("minidump")
  return {
    id: report.stem,
    runtime: "desktop",
    source: report.kind ?? "unknown",
    capturedAt: report.capturedAt ?? new Date(0).toISOString(),
    // The receipt is the authority once one exists; a report that was never
    // submitted has only ever been detected.
    state: normalizeIncidentClientState(submission?.clientState) ?? "detected",
    receiptCode: submission?.supportCode || undefined,
    sizeBytes: report.sizeBytes,
    artifacts,
    submission,
  }
}

function normalizeMobile(report: MobileCrashSummary): DiagnosticIncidentSummary {
  const receiptCode = report.receiptCode?.trim() || undefined
  // The plugin stores the service's own `clientState` through `markReceipt`.
  // An unrecognized one with a receipt still means "sent": `processing` is
  // the honest floor for a report the service acknowledged.
  const state =
    normalizeIncidentClientState(report.state) ?? (receiptCode ? "processing" : "detected")
  return {
    id: report.incidentId,
    runtime: "mobile",
    source: report.source,
    capturedAt: new Date(report.detectedAt).toISOString(),
    state,
    receiptCode,
    sizeBytes: report.sizeBytes,
    artifacts: ["report"],
  }
}

export interface DiagnosticIncidentListing {
  incidents: DiagnosticIncidentSummary[]
  /**
   * The runtimes on this device that can hold crash reports at all: the
   * desktop under Tauri, mobile when the crash plugin answered. Empty in the
   * plain browser, which captures none — a different statement from "none
   * captured", and the Crash reports channel says so.
   */
  runtimes: IncidentRuntime[]
}

/**
 * Read every report. A desktop crash directory that cannot be read rejects
 * (surfaced as the channel's error) rather than reading as an empty, healthy
 * list.
 */
export async function listDiagnosticIncidents(
  dependencies: DiagnosticIncidentDependencies = defaultDependencies
): Promise<DiagnosticIncidentListing> {
  const [desktop, mobile, submissions] = await Promise.all([
    dependencies.listDesktop(),
    dependencies.listMobile(),
    dependencies.listSubmissions(),
  ])
  const incidents = desktop.map((report) => normalizeDesktop(report, submissions[report.stem]))
  if (mobile.kind === "ok") incidents.push(...mobile.value.map(normalizeMobile))
  const runtimes: IncidentRuntime[] = []
  if ((dependencies.isDesktop ?? isTauri)()) runtimes.push("desktop")
  if (mobile.kind === "ok") runtimes.push("mobile")
  return {
    incidents: incidents.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt)),
    runtimes,
  }
}

/** The incidents alone, for callers that do not render runtime availability. */
export async function loadDiagnosticIncidents(
  dependencies: DiagnosticIncidentDependencies = defaultDependencies
): Promise<DiagnosticIncidentSummary[]> {
  return (await listDiagnosticIncidents(dependencies)).incidents
}

export function useDiagnosticIncidents(
  dependencies: DiagnosticIncidentDependencies = defaultDependencies
) {
  const [incidents, setIncidents] = useState<DiagnosticIncidentSummary[]>([])
  const [runtimes, setRuntimes] = useState<IncidentRuntime[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const listing = await listDiagnosticIncidents(dependencies)
      setIncidents(listing.incidents)
      setRuntimes(listing.runtimes)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      setLoading(false)
    }
  }, [dependencies])

  useEffect(() => {
    let active = true
    void listDiagnosticIncidents(dependencies)
      .then((listing) => {
        if (!active) return
        setIncidents(listing.incidents)
        setRuntimes(listing.runtimes)
        setError(null)
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause : new Error(String(cause)))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [dependencies])

  const read = useCallback(
    async (incident: DiagnosticIncidentSummary): Promise<unknown> => {
      if (incident.runtime === "desktop") return dependencies.readDesktop(incident.id)
      const outcome = await dependencies.readMobile(incident.id)
      if (outcome.kind === "ok") return outcome.value
      if (outcome.kind === "error") throw new Error(outcome.message)
      return null
    },
    [dependencies]
  )

  const remove = useCallback(
    async (incident: DiagnosticIncidentSummary): Promise<boolean> => {
      const removed =
        incident.runtime === "desktop"
          ? await dependencies.deleteDesktop(incident.id)
          : (await dependencies.deleteMobile(incident.id)).kind === "ok"
      if (removed) await refresh()
      return removed
    },
    [dependencies, refresh]
  )

  return useMemo(
    () => ({ incidents, runtimes, loading, error, refresh, read, remove }),
    [error, incidents, loading, read, refresh, remove, runtimes]
  )
}
