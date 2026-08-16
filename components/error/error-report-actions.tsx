"use client"

/**
 * Report actions for the error page.
 *
 * - "Copy full report": assembles the unified support report — the current
 *   error + stack, the runtime snapshot, the recent-error stream — through
 *   `lib/support-report` and writes it to the clipboard. This complements the
 *   JSON crash-log *download* (`exportCrashLogBundleNow`): the download is for
 *   archival, this is for pasting into a support thread.
 * - "Report issue": opens the tracker with the same report pre-filled. The
 *   tracker is `NEXT_PUBLIC_ISSUE_REPORT_URL` when configured, otherwise the
 *   project's public repository (`resolveIssueTrackerUrl`).
 *
 * Both are the `copy` / `issue` channels of `lib/support-report/channels`, so
 * this page, the Support strip, the mobile Feedback page and a notification
 * row all produce byte-identical reports.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, Copy, ExternalLink } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import type { ErrorCategory } from "@/lib/error/classify-error"
import { buildSupportReport } from "@/lib/support-report/build"
import { deliverSupportReport, type SupportReportChannelDeps } from "@/lib/support-report/channels"
import type { SupportReportContext } from "@/lib/support-report/types"

export interface ErrorReportContext {
  category: ErrorCategory
  locale: string
  pathname: string | null
}

export interface ErrorReportCopy {
  copyReport: string
  copyReportSuccess: string
  copyReportFailed: string
  reportIssue: string
  reportIssueFailed: string
}

export interface ErrorReportActionsProps {
  error?: (Error & { digest?: string }) | null
  copy: ErrorReportCopy
  context: ErrorReportContext
  /** Suppress sonner toasts (static global-error path has no Toaster). */
  toastsEnabled: boolean
  /** Configured issue tracker URL. Defaults to `NEXT_PUBLIC_ISSUE_REPORT_URL`, then the public repo. */
  issueReportUrl?: string
  /** Test seams for the built-in channels. */
  channelDeps?: SupportReportChannelDeps
  build?: typeof buildSupportReport
}

export function ErrorReportActions({
  error,
  copy,
  context,
  toastsEnabled,
  issueReportUrl = process.env.NEXT_PUBLIC_ISSUE_REPORT_URL,
  channelDeps,
  build = buildSupportReport,
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

  const reportContext = useMemo<SupportReportContext>(
    () => ({
      surface: "error-page",
      category: context.category,
      locale: context.locale,
      route: context.pathname,
      error: error
        ? {
            name: error.name,
            message: error.message,
            ...(error.stack ? { stack: error.stack } : {}),
            ...(error.digest ? { digest: error.digest } : {}),
          }
        : null,
    }),
    [context.category, context.locale, context.pathname, error]
  )

  const deps = useMemo<SupportReportChannelDeps>(
    () => ({
      ...channelDeps,
      ...(issueReportUrl ? { issueTrackerUrl: issueReportUrl } : {}),
    }),
    [channelDeps, issueReportUrl]
  )

  const handleCopy = useCallback(async () => {
    if (copying) return
    setCopying(true)
    try {
      const report = await build({ context: reportContext })
      await deliverSupportReport("copy", report, deps)
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
    build,
    copy.copyReportFailed,
    copy.copyReportSuccess,
    copying,
    deps,
    reportContext,
    toastsEnabled,
  ])

  const handleReportIssue = useCallback(async () => {
    try {
      const report = await build({ context: reportContext })
      await deliverSupportReport("issue", report, deps)
    } catch {
      if (toastsEnabled) toast.error(copy.reportIssueFailed)
    }
  }, [build, copy.reportIssueFailed, deps, reportContext, toastsEnabled])

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
    </>
  )
}
