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
 * (`buildIssueUrl`) are pure and exported so they're independently testable.
 */

import { useCallback, useState } from "react"
import { Copy, ExternalLink } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { getRecentErrorLogs } from "@/lib/logging/recent-errors"
import { getLocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import type { LocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import type { ErrorCategory } from "@/lib/error/classify-error"
import type { StructuredLogEntry } from "@/types/logging"

export interface ErrorReportCopy {
  copyReport: string
  copyReportSuccess: string
  copyReportFailed: string
  reportIssue: string
}

export interface ErrorReportContext {
  category: ErrorCategory
  locale: string
  pathname: string | null
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

const MAX_ISSUE_BODY = 6000

function defaultWriteClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text)
}

function defaultOpenUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer")
}

/** Build the human-readable Markdown report copied to the clipboard. */
export function buildErrorReportMarkdown(params: {
  error?: (Error & { digest?: string }) | null
  context: ErrorReportContext
  recent: StructuredLogEntry[]
  diagnostics: LocalRuntimeDiagnostics | null
  generatedAt: string
}): string {
  const { error, context, recent, diagnostics, generatedAt } = params
  const lines: string[] = []

  lines.push("## Cognia error report")
  lines.push("")
  lines.push(`- Generated: ${generatedAt}`)
  lines.push(`- Category: ${context.category}`)
  lines.push(`- Route: ${context.pathname ?? "—"}`)
  lines.push(`- Locale: ${context.locale}`)
  if (error?.digest) lines.push(`- Error ID: ${error.digest}`)
  lines.push("")

  lines.push("### Error")
  if (error) {
    lines.push("```")
    lines.push(`${error.name}: ${error.message}`)
    if (error.stack) lines.push(error.stack)
    lines.push("```")
  } else {
    lines.push("_No error object was provided._")
  }
  lines.push("")

  lines.push("### Diagnostics")
  if (diagnostics) {
    lines.push("```json")
    lines.push(JSON.stringify(diagnostics, null, 2))
    lines.push("```")
  } else {
    lines.push("_Diagnostics unavailable._")
  }
  lines.push("")

  lines.push(`### Recent errors (${recent.length})`)
  if (recent.length > 0) {
    for (const entry of recent) {
      lines.push(`- ${entry.timestamp} [${entry.level}] ${entry.module}: ${entry.message}`)
    }
  } else {
    lines.push("_None recorded._")
  }
  lines.push("")

  return lines.join("\n")
}

/** Build a pre-filled issue-tracker URL from the configured base. */
export function buildIssueUrl(base: string, title: string, body: string): string {
  const normalized = base.replace(/\/+$/, "")
  const endpoint = /\/issues\/new$/.test(normalized) ? normalized : `${normalized}/issues/new`
  const truncatedBody = body.length > MAX_ISSUE_BODY ? `${body.slice(0, MAX_ISSUE_BODY)}\n…` : body
  const params = new URLSearchParams({ title, body: truncatedBody })
  return `${endpoint}?${params.toString()}`
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
        onClick={handleCopy}
        disabled={copying}
        className="gap-2"
        data-testid="error-page-copy-report"
      >
        <Copy className="size-4" aria-hidden="true" />
        {copy.copyReport}
      </Button>
      {issueReportUrl && (
        <Button
          variant="ghost"
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
