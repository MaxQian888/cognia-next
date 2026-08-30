/**
 * Plain-text projection of a message FOR PROJECT MINING — the one place that
 * includes tool output.
 *
 * `extractPlainText` (the inbox/search projection every other memory path uses)
 * walks text / markdown / code / image / a2ui parts and skips tool parts
 * entirely. That is right for search and wrong here: a project's verified
 * outcomes and environment gotchas live almost exclusively in what Read, Bash,
 * Grep and Edit actually returned. Mining on the search projection can see an
 * assistant CLAIM that the suite passed but never the run that proves it, so
 * the `outcome` claim kind — which the extractor is told to emit only with tool
 * evidence — is unreachable, and so is the `tool-result` evidence kind.
 *
 * Tool bodies are the reason `normalizeProjectPaths` exists and runs first: this
 * projection is saturated with absolute paths carrying the OS username.
 *
 * Reuses `isToolPart` / `projectToolOutputText` rather than re-deriving what a
 * tool part is — the `@result:` mention selector already answers that question,
 * including the two live part dialects (`tool-<name>` and `dynamic-tool`) and
 * the "a failed call returns its error" rule.
 */

import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { isToolPart, projectToolOutputText } from "@/lib/chat/mentions/tool-output-text"

/**
 * Per-tool-part budget, applied ON TOP of `projectToolOutputText`'s own 8k cap.
 *
 * A mining window is budgeted at ~6000 tokens total, so one uncapped 8k-char
 * tool result would consume the whole window and push every other message out.
 * Truncation is announced, not silent: an elided body that looks complete is
 * how a claim gets mined from evidence that was never really there.
 */
export const MINING_TOOL_OUTPUT_MAX_CHARS = 1_500

export interface ProjectMiningTextOptions {
  maxToolChars?: number
}

/**
 * `parts` projected to the text the extractor is shown.
 *
 * Tool parts are labelled with their PART INDEX, because that index is the
 * second half of a `tool-result` evidence `sourceId` (`<messageId>:<index>`) —
 * without it in the text the model has no way to cite one, and every tool
 * citation would be dropped as unanchored.
 */
export function projectMiningMessageText(
  parts: unknown,
  options: ProjectMiningTextOptions = {}
): string {
  const base = extractPlainText(parts)
  if (!Array.isArray(parts)) return base

  const maxToolChars = Math.max(1, options.maxToolChars ?? MINING_TOOL_OUTPUT_MAX_CHARS)
  const segments: string[] = base ? [base] : []

  parts.forEach((part, index) => {
    if (!part || typeof part !== "object") return
    if (!isToolPart(part as { type?: unknown })) return
    const output = projectToolOutputText(part as Parameters<typeof projectToolOutputText>[0])
    if (!output) return
    const clipped =
      output.length > maxToolChars ? `${output.slice(0, maxToolChars)}\n…[truncated]` : output
    segments.push(`[tool ${index}] ${clipped}`)
  })

  return segments.join("\n")
}
