"use client"

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
import type { MobileCrashSummary } from "@/lib/capacitor/crash-diagnostics"

export interface DiagnosticIncidentSummary {
  id: string
  runtime: "desktop" | "mobile"
  source: string
  capturedAt: string
  state: string
  receiptCode?: string
  sizeBytes: number
  artifacts: Array<"text" | "metadata" | "minidump" | "report">
}

type MobileListOutcome = Awaited<ReturnType<typeof listMobileCrashReports>>
type MobileReadOutcome = Awaited<ReturnType<typeof readMobileCrashReport>>
type MobileDeleteOutcome = Awaited<ReturnType<typeof deleteMobileCrashReport>>

export interface DiagnosticIncidentDependencies {
  listDesktop: () => Promise<CrashReportSummary[]>
  listMobile: () => Promise<MobileListOutcome>
  readDesktop: (id: string) => Promise<string | null>
  readMobile: (id: string) => Promise<MobileReadOutcome>
  deleteDesktop: (id: string) => Promise<boolean>
  deleteMobile: (id: string) => Promise<MobileDeleteOutcome>
}

const defaultDependencies: DiagnosticIncidentDependencies = {
  listDesktop: listCrashReports,
  listMobile: listMobileCrashReports,
  readDesktop: readCrashReport,
  readMobile: readMobileCrashReport,
  deleteDesktop: deleteCrashReport,
  deleteMobile: deleteMobileCrashReport,
}

function normalizeDesktop(report: CrashReportSummary): DiagnosticIncidentSummary {
  const artifacts: DiagnosticIncidentSummary["artifacts"] = []
  if (report.hasTxt) artifacts.push("text")
  if (report.hasJson) artifacts.push("metadata")
  if (report.hasDmp) artifacts.push("minidump")
  return {
    id: report.stem,
    runtime: "desktop",
    source: report.kind ?? "unknown",
    capturedAt: report.capturedAt ?? new Date(0).toISOString(),
    state: "detected",
    sizeBytes: report.sizeBytes,
    artifacts,
  }
}

function normalizeMobile(report: MobileCrashSummary): DiagnosticIncidentSummary {
  return {
    id: report.incidentId,
    runtime: "mobile",
    source: report.source,
    capturedAt: new Date(report.detectedAt).toISOString(),
    state: report.state,
    receiptCode: report.receiptCode,
    sizeBytes: report.sizeBytes,
    artifacts: ["report"],
  }
}

export async function loadDiagnosticIncidents(
  dependencies: DiagnosticIncidentDependencies = defaultDependencies
): Promise<DiagnosticIncidentSummary[]> {
  const [desktop, mobile] = await Promise.all([
    dependencies.listDesktop(),
    dependencies.listMobile(),
  ])
  const incidents = desktop.map(normalizeDesktop)
  if (mobile.kind === "ok") incidents.push(...mobile.value.map(normalizeMobile))
  return incidents.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
}

export function useDiagnosticIncidents(
  dependencies: DiagnosticIncidentDependencies = defaultDependencies
) {
  const [incidents, setIncidents] = useState<DiagnosticIncidentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setIncidents(await loadDiagnosticIncidents(dependencies))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      setLoading(false)
    }
  }, [dependencies])

  useEffect(() => {
    let active = true
    void loadDiagnosticIncidents(dependencies)
      .then((loaded) => {
        if (!active) return
        setIncidents(loaded)
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
    () => ({ incidents, loading, error, refresh, read, remove }),
    [error, incidents, loading, read, refresh, remove]
  )
}
