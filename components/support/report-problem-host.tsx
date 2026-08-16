"use client"

/**
 * Root-mounted consumer of `useUIStore().pendingReportRequest`.
 *
 * Surfaces with no dialog of their own — the tray's "Report issue", the
 * `/report` slash command — raise a request on the store; this host renders
 * the one {@link ReportProblemDialog} for it and clears the request when the
 * dialog closes. Keyed on the request nonce so a second request while the
 * dialog is already open starts a fresh form.
 */

import { useUIStore } from "@/stores/ui"

import { ReportProblemDialog } from "./report-problem-dialog"

export function ReportProblemHost() {
  const request = useUIStore((s) => s.pendingReportRequest)
  const clearPendingReport = useUIStore((s) => s.clearPendingReport)
  if (!request) return null
  return (
    <ReportProblemDialog
      key={request.nonce}
      context={request.context}
      open
      onOpenChange={(open) => {
        if (!open) clearPendingReport()
      }}
    />
  )
}
