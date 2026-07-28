"use client"

/**
 * Report actions for the error page.
 *
 * - "Copy full report" (always available): assembles a human-readable Markdown
 *   report — the current error + stack, the recent-error stream, and a runtime
 *   diagnostics snapshot — and writes it to the clipboard so a user can paste it
 *   into a support thread. This complements the existing JSON crash-log *download*
 *   (`exportCrashLogBundleNow`): the download is for archival, this is for pasting.
 * - "Report issue" (conditional): only rendered when an issue-tracker URL is
 *   configured via `NEXT_PUBLIC_ISSUE_REPORT_URL`. No repository is hard-coded.
 *
 * The report builder (`buildErrorReportMarkdown`) and the issue-URL builder
 * (`buildIssueUrl`) live in `lib/error/build-report.ts` so surfaces that aren't
 * this page — an inline diagnostic card, a toast, a notification-center row —
 * can offer the same two actions without importing a React component.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Copy, ExternalLink } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { getRecentErrorLogs } from "@cognia/logging/recent-errors"
import { getLocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import {
  buildErrorReportMarkdown,
  buildIssueUrl,
  type ErrorReportContext,
} from "@/lib/error/build-report"

export type { ErrorReportContext }

export interface ErrorReportCopy {
  copyReport: string
  copyReportSuccess: string
  copyReportFailed: string
  reportIssue: string
}

export interface ErrorReportActionsProps {
  error?: (Error & { digest?: string }) | null
  copy: ErrorReportCopy
  context: ErrorReportContext
  /** Suppress sonner toasts (static global-error path has no Toaster). */
  toastsEnabled: boolean
  /** Configured issue tracker URL. Defaults to `NEXT_PUBLIC_ISSUE_REPORT_URL`. */
  issueReportUrl?: string
  /** Test seams. */
  getDiagnostics?: typeof getLocalRuntimeDiagnostics
  getRecentErrors?: typeof getRecentErrorLogs
  writeClipboard?: (text: string) => Promise<void>
  openUrl?: (url: string) => void
}

function defaultWriteClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text)
}

function defaultOpenUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer")
}

export function ErrorReportActions({
  error,
  copy,
  context,
  toastsEnabled,
  issueReportUrl = process.env.NEXT_PUBLIC_ISSUE_REPORT_URL,
  getDiagnostics = getLocalRuntimeDiagnostics,
  getRecentErrors = getRecentErrorLogs,
  writeClipboard = defaultWriteClipboard,
  openUrl = defaultOpenUrl,
}: ErrorReportActionsProps) {
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    []
  )

  const buildReport = useCallback(async (): Promise<string> => {
    const recent = getRecentErrors()
    const diagnostics = await getDiagnostics().catch(() => null)
    return buildErrorReportMarkdown({
      error,
      context,
      recent,
      diagnostics,
      generatedAt: new Date().toISOString(),
    })
  }, [error, context, getDiagnostics, getRecentErrors])

  const handleCopy = useCallback(async () => {
    if (copying) return
    setCopying(true)
    try {
      const report = await buildReport()
      await writeClipboard(report)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1600)
      if (toastsEnabled) toast.success(copy.copyReportSuccess)
    } catch {
      if (toastsEnabled) toast.error(copy.copyReportFailed)
    } finally {
      setCopying(false)
    }
  }, [
    buildReport,
    copy.copyReportFailed,
    copy.copyReportSuccess,
    copying,
    toastsEnabled,
    writeClipboard,
  ])

  const handleReportIssue = useCallback(async () => {
    if (!issueReportUrl) return
    const report = await buildReport()
    const title = error
      ? `[${context.category}] ${error.message}`
      : `[${context.category}] Error report`
    openUrl(buildIssueUrl(issueReportUrl, title, report))
  }, [buildReport, context.category, error, issueReportUrl, openUrl])

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        disabled={copying}
        className="gap-2"
        data-testid="error-page-copy-report"
      >
        {copied ? (
          <Check className="size-4 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
        {copy.copyReport}
      </Button>
      {issueReportUrl && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleReportIssue}
          className="gap-2"
          data-testid="error-page-report-issue"
        >
          <ExternalLink className="size-4" aria-hidden="true" />
          {copy.reportIssue}
        </Button>
      )}
    </>
  )
}
