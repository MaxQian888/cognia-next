/**
 * Report persistence — the one place a research result escapes the chat.
 *
 * A multi-section report is a document, and the workspace artifact panel is
 * the host's document surface: versioned, exportable (raw/html/pdf) and
 * reachable after the conversation scrolls on. Search-mode answers stay in
 * the chat — a paragraph with a sources list is a message, not a document.
 *
 * Persistence is best-effort by contract: a host without the artifact API or
 * a run without the `artifact:write` grant still gets its report back — the
 * tool result just lacks `artifactId`.
 */
import type { PluginContext } from "@cognia/plugin-sdk"

import type { DeepResearchResult } from "./types"

export interface ReportArtifactOptions {
  sessionId?: string
  messageId?: string
}

/**
 * Save the finished report as a plugin-owned markdown artifact and return its
 * id. Never throws — a persistence failure must not downgrade a completed
 * research run into an error.
 */
export async function persistReport(
  ctx: PluginContext,
  report: DeepResearchResult,
  options: ReportArtifactOptions = {}
): Promise<string | undefined> {
  try {
    return await ctx.artifact.createArtifact({
      title: report.title,
      content: report.report,
      type: "document",
      language: "markdown",
      kind: "report",
      schemaVersion: 1,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.messageId ? { messageId: options.messageId } : {}),
      metadata: {
        sourceOrigin: "tool",
        userInitiated: true,
        exportFormats: ["raw", "html", "pdf"],
        wordCount: report.report.split(/\s+/).filter(Boolean).length,
      },
    })
  } catch (err) {
    ctx.logger?.warn("deep-research: report artifact could not be saved", err)
    return undefined
  }
}
