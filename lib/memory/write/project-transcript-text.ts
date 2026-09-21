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
import { stripPromptPreambleFromParts } from "@/lib/chat/prompt-preamble"
import { readAttachmentExtractedContent } from "@cognia/agent-config-types/attachment"
import {
  attachmentEvidenceSourceId,
  type ProjectAttachmentEvidenceSource,
} from "@cognia/memory/extract/project-attachment-evidence"

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
  includeAttachments?: boolean
  includeProse?: boolean
}

export const MINING_ATTACHMENT_CHUNK_CHARS = 1_500

/** Only authored prose is eligible to become a statement attributed to its speaker. */
export function memoryTranscriptProse(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return extractPlainText(
    stripPromptPreambleFromParts(parts).filter((part: unknown) => {
      if (!part || typeof part !== "object") return false
      const value = part as Record<string, unknown>
      return (
        ["text", "markdown", "code", "a2ui"].includes(String(value.type)) &&
        value.extractedContent === undefined &&
        value.videoAttachment === undefined
      )
    })
  )
}

export interface ProjectMiningAttachmentExcerpt {
  source: ProjectAttachmentEvidenceSource
  sourceId: string
  text: string
  context: string
}

/** Consume only persisted parser output; never fetch an attachment URL during mining. */
export function projectMiningAttachmentExcerpts(
  parts: unknown,
  messageId: string
): ProjectMiningAttachmentExcerpt[] {
  if (!Array.isArray(parts)) return []
  const excerpts: ProjectMiningAttachmentExcerpt[] = []
  const seen = new Set<string>()
  parts.forEach((part: unknown, partIndex) => {
    if (!part || typeof part !== "object") return
    const file = part as { type?: unknown; extractedContent?: unknown }
    const content = readAttachmentExtractedContent(file.extractedContent)
    if (file.type !== "file" || !content || !["ready", "partial"].includes(content.status)) return
    const identity = `${content.attachmentId}:${content.contentHash}`
    if (seen.has(identity)) return
    seen.add(identity)
    for (const segment of content.segments) {
      if (
        !segment ||
        typeof segment.id !== "string" ||
        !segment.id ||
        typeof segment.text !== "string" ||
        !segment.text.trim() ||
        !segment.locator ||
        typeof segment.locator !== "object"
      )
        continue
      const locator = JSON.stringify(segment.locator)
      for (let start = 0; start < segment.text.length; start += MINING_ATTACHMENT_CHUNK_CHARS) {
        const end = Math.min(start + MINING_ATTACHMENT_CHUNK_CHARS, segment.text.length)
        const source = {
          messageId,
          partIndex,
          attachmentId: content.attachmentId,
          contentHash: content.contentHash,
          segmentId: segment.id,
          locator,
          start,
          end,
        }
        excerpts.push({
          source,
          sourceId: attachmentEvidenceSourceId(source),
          text: segment.text.slice(start, end),
          context: `Extraction ${content.status}; derivation ${segment.derivation ?? "text"}${content.coverage ? `; coverage ${content.coverage.processed}/${content.coverage.total} ${content.coverage.unit}` : ""}`,
        })
      }
    }
  })
  return excerpts
}

/** Exact tool segment, independently re-checkable when surrounding prose is excluded. */
export function projectMiningToolText(
  parts: readonly unknown[],
  index: number,
  maxToolChars = MINING_TOOL_OUTPUT_MAX_CHARS
): string | undefined {
  const part = parts[index]
  if (!part || typeof part !== "object" || !isToolPart(part as { type?: unknown })) return undefined
  const output = projectToolOutputText(part as Parameters<typeof projectToolOutputText>[0])
  if (!output) return undefined
  const clipped =
    output.length > maxToolChars ? `${output.slice(0, maxToolChars)}\n…[truncated]` : output
  return `[tool ${index}] ${clipped}`
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
  if (!Array.isArray(parts)) return extractPlainText(parts)
  // The text half skips the composer's context envelope — a referenced document
  // is not a statement the user made. Tool parts below still walk the ORIGINAL
  // array, because their index is half of an evidence id.
  const base = options.includeProse === false ? "" : memoryTranscriptProse(parts)

  const maxToolChars = Math.max(1, options.maxToolChars ?? MINING_TOOL_OUTPUT_MAX_CHARS)
  const segments: string[] = base ? [base] : []

  parts.forEach((_part, index) => {
    const text = projectMiningToolText(parts, index, maxToolChars)
    if (text !== undefined) segments.push(text)
  })

  if (options.includeAttachments !== false) {
    for (const excerpt of projectMiningAttachmentExcerpts(parts, "projection")) {
      segments.push(
        `[attachment ${excerpt.source.partIndex}:${excerpt.source.segmentId} ${excerpt.source.locator}] External source data: ${excerpt.text}`
      )
    }
  }

  return segments.join("\n")
}
