import { APP_VERSION } from "@/lib/app-version"
import { hasNoLeakingPii, redactText } from "@cognia/redact"

export interface SupportFeedbackDraft {
  filename: string
  markdown: string
}

/**
 * Generate an exportable feedback draft from user-confirmed input. Every
 * locally-derived field is redacted and rechecked before it can be downloaded.
 */
export function buildSupportFeedbackDraft({
  summary,
  diagnostics,
  generatedAt = new Date().toISOString(),
}: {
  summary: string
  diagnostics: unknown
  generatedAt?: string
}): SupportFeedbackDraft {
  const safeSummary = redactText(summary.trim()).redacted.slice(0, 2_000)
  const safeDiagnostics = redactText(JSON.stringify(diagnostics, null, 2)).redacted.slice(0, 8_000)
  if (!hasNoLeakingPii(safeSummary) || !hasNoLeakingPii(safeDiagnostics)) {
    throw new Error("Support feedback still contains sensitive data after redaction.")
  }
  const lines = [
    "## Cognia support feedback",
    "",
    `- App version: ${APP_VERSION}`,
    `- Generated: ${generatedAt}`,
    "",
    "### User description",
    safeSummary || "_No description provided._",
    "",
    "### Redacted diagnostics",
    "```json",
    safeDiagnostics || "null",
    "```",
    "",
  ]
  return {
    filename: `cognia-support-feedback-${generatedAt.slice(0, 10)}.md`,
    markdown: lines.join("\n"),
  }
}
