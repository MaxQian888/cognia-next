/**
 * Shared types + helpers for chat-export importers (M1 of the twin closeout).
 *
 * Every platform (ChatGPT / Claude / Gemini / Slack / Lark / DingTalk /
 * WeChat) parses to the intermediate `ChatMessageBlock[]` shape, then
 * renders to a markdown transcript that `createTwinSource` stores as the
 * pre-extracted body (format: "markdown"). The downstream `parse.ts`
 * passthrough treats it as preformatted text, the `paragraph` /
 * `heading` chunker slices on `### speaker @ ts` headers, and the
 * embedder sees one paragraph per message.
 */

import type { RawSource } from "@/lib/twin/ingest/parse"
import type { TwinChunkMetadata } from "@/types/twin"

/** One message, normalised to the lowest common form across all platforms. */
export interface ChatMessageBlock {
  speaker: string
  /** ms-since-epoch when the message was sent (when the export records it). */
  timestamp?: number
  text: string
  /** Optional thread key — Slack thread_ts, Lark/DingTalk thread root. */
  threadId?: string
  /** Optional external id (Slack ts, ChatGPT mapping id, …). */
  externalId?: string
}

/** Common option bag passed by the source uploader to every importer. */
export interface ChatImporterOptions {
  twinId: string
  /** Display label for the resulting TwinSource (e.g. "#engineering 2024-01-15"). */
  source?: string
  /**
   * Optional user-id → display-name map applied to `block.speaker` before
   * markdown render. Used by Slack to resolve raw user ids to humans.
   */
  userMap?: Record<string, string>
}

/**
 * Render `blocks` to the canonical markdown transcript used by every
 * chat importer. Format:
 *
 *   # <title>
 *
 *   ### <speaker> @ <ISO timestamp>
 *   <message body>
 *
 *   ### <speaker>
 *   <message body>
 *
 * The `### speaker` header is `heading`-chunker-friendly while still
 * being readable to a human reviewer.
 */
export function blocksToMarkdown(title: string, blocks: ChatMessageBlock[]): string {
  const lines: string[] = [`# ${title}`, ""]
  for (const block of blocks) {
    if (!block.text.trim()) continue
    const stamp = block.timestamp ? ` @ ${new Date(block.timestamp).toISOString()}` : ""
    lines.push(`### ${block.speaker}${stamp}`)
    lines.push(block.text.trimEnd())
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

/** Distinct speakers in insertion order (stable for downstream metadata). */
export function collectSpeakers(blocks: ChatMessageBlock[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const block of blocks) {
    if (block.speaker && !seen.has(block.speaker)) {
      seen.add(block.speaker)
      out.push(block.speaker)
    }
  }
  return out
}

/** Earliest + latest timestamps (when present), for chunk metadata. */
export function timestampRange(blocks: ChatMessageBlock[]): {
  earliest?: number
  latest?: number
} {
  const stamps = blocks
    .map((b) => b.timestamp)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t))
  if (stamps.length === 0) return {}
  return { earliest: Math.min(...stamps), latest: Math.max(...stamps) }
}

/** Stable id generator for a chat-importer-produced `RawSource`. */
let counter = 0
export function nextRawSourceId(twinId: string, label: string): string {
  counter += 1
  const stamp = Date.now().toString(36)
  return `tws_${label}_${twinId}_${stamp}_${counter}`
}

/**
 * Convert a parsed conversation to a single `RawSource`. Title becomes the
 * filename; `speakers` lands in `baseMetadata` for downstream chunk tags.
 */
export interface ConversationToRawSourceInput {
  twinId: string
  title: string
  blocks: ChatMessageBlock[]
  /** Tag prefix used for the source id (e.g. "chatgpt", "slack"). */
  label: string
  /** Optional extra metadata merged onto `baseMetadata`. */
  extraMetadata?: TwinChunkMetadata
}

export function conversationToRawSource(input: ConversationToRawSourceInput): RawSource | null {
  if (input.blocks.length === 0) return null
  const speakers = collectSpeakers(input.blocks)
  const { earliest, latest } = timestampRange(input.blocks)
  const baseMetadata: TwinChunkMetadata = {
    speakers,
    ...(earliest !== undefined ? { timestamp: earliest } : {}),
    ...(latest !== undefined && latest !== earliest ? { timestampMax: latest } : {}),
    ...input.extraMetadata,
  }
  return {
    id: nextRawSourceId(input.twinId, input.label),
    filename: `${input.title}.md`,
    format: "markdown",
    text: blocksToMarkdown(input.title, input.blocks),
    baseMetadata,
  }
}
