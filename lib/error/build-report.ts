/**
 * Pure builders for the "copy report" / "report issue" affordances.
 *
 * These lived inside `components/error/error-report-actions.tsx`, which meant
 * only the full-page error boundary could produce a report. Every other surface
 * that wants to offer `copy-report` or `report-issue` — an inline diagnostic
 * card in chat, a toast, a notification-center row — would have had to import a
 * React component to reach them.
 *
 * Nothing here touches the DOM or React, so it works from any of those callers
 * and from a node-env test.
 */

import type { LocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import type { ErrorCategory } from "@/lib/error/classify-error"
import type { StructuredLogEntry } from "@/types/logging"

export interface ErrorReportContext {
  category: ErrorCategory
  locale: string
  pathname: string | null
}

export interface ErrorReportInput {
  error?: (Error & { digest?: string }) | null
  context: ErrorReportContext
  recent: StructuredLogEntry[]
  diagnostics: LocalRuntimeDiagnostics | null
  generatedAt: string
}

/**
 * Trackers reject very long query strings, and a 200k-character stack pasted
 * into a URL fails silently rather than loudly. Truncate before that happens.
 */
const MAX_ISSUE_BODY = 6000

/** Build the human-readable Markdown report copied to the clipboard. */
export function buildErrorReportMarkdown(params: ErrorReportInput): string {
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
