// Pure functions that turn three different source channels into the unified
// SourcesPartItem[] shape consumed by SourcesPart:
//
//  - Anthropic Citations API — `citations` field on text blocks
//  - Twin RAG — retrieved chunks from `applyTwinContext`
//  - Markdown footnotes — `[^N]: <body>` lines in the assistant text
//
// Kept dependency-free so unit tests can run without React, Dexie, or the
// vector store.

import type { BetaContentBlock } from "@cognia/agent-config-types"
import type { SourcesPartItem } from "./parts-extensions"

/**
 * Anthropic citation shape — kept as a single permissive interface so older /
 * private-beta variants of the API don't trip type narrowing. Real-world
 * payloads carry only a subset of these fields depending on which citation
 * source (web_search / page_location / url_citation / …) emitted the row.
 */
interface AnthropicCitation {
  type?: string
  url?: string
  title?: string
  text?: string
  cited_text?: string
  document_title?: string
  document_index?: number
}

/**
 * Extract `SourcesPartItem[]` from any text blocks that carry the Anthropic
 * `citations` field. Order is preserved; the returned items deduplicate by
 * URL (or by title when no URL is present) so the same web result cited
 * multiple times collapses to a single entry.
 */
export function extractAnthropicCitations(blocks: BetaContentBlock[]): SourcesPartItem[] {
  const out: SourcesPartItem[] = []
  const seen = new Set<string>()
  let slot = 0
  for (const block of blocks) {
    if (block.type !== "text") continue
    const citations = (block as unknown as { citations?: AnthropicCitation[] }).citations
    if (!Array.isArray(citations) || citations.length === 0) continue
    for (const c of citations) {
      slot += 1
      const url = typeof c.url === "string" ? c.url : undefined
      const title =
        (typeof c.title === "string" && c.title) ||
        (typeof c.document_title === "string" ? c.document_title : undefined) ||
        url ||
        `Citation ${slot}`
      const key = url || title
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        id: `anthropic-${slot}`,
        title,
        url,
        snippet: truncate(c.cited_text ?? c.text, 200),
        origin: "anthropic",
      })
    }
  }
  return out
}

/**
 * Twin-RAG retrieved chunk → SourcesPartItem. Shape mirrors what
 * `applyTwinContext` returns (chunk row + score + optional source title).
 */
export interface TwinRetrievedChunk {
  chunk: { vectorDocId: string; content: string; sourceId: string }
  score: number
  sourceTitle?: string
}

export function extractTwinRagSources(
  chunks: readonly TwinRetrievedChunk[] | undefined | null
): SourcesPartItem[] {
  if (!chunks || chunks.length === 0) return []
  return chunks.map((rc, i) => ({
    id: `twin-${rc.chunk.vectorDocId || i}`,
    title: rc.sourceTitle || `Twin chunk ${i + 1}`,
    snippet: truncate(rc.chunk.content, 200),
    origin: "twin-rag",
    score: typeof rc.score === "number" ? rc.score : undefined,
  }))
}

const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:\s+(.+?)\s*$/gm
const FOOTNOTE_URL_RE = /(https?:\/\/[^\s)]+)/

/**
 * Pull markdown footnote definitions (`[^1]: body`) out of `text` and
 * return them as sources. URLs in the body are surfaced on the source's
 * `url` field so the Source link is clickable.
 */
export function extractFootnoteSources(text: string | undefined | null): SourcesPartItem[] {
  if (!text || typeof text !== "string") return []
  FOOTNOTE_DEF_RE.lastIndex = 0
  const out: SourcesPartItem[] = []
  let m: RegExpExecArray | null
  while ((m = FOOTNOTE_DEF_RE.exec(text)) !== null) {
    const ref = m[1]
    const body = m[2]
    const urlMatch = body.match(FOOTNOTE_URL_RE)
    out.push({
      id: `footnote-${ref}`,
      title: `Note ${ref}`,
      url: urlMatch ? urlMatch[1] : undefined,
      snippet: truncate(body, 200),
      origin: "footnote",
    })
  }
  return out
}

/**
 * Merge sources from all three channels into a single deduplicated list.
 * Order: anthropic → twin-rag → footnote (so user-emphasized citations win
 * when titles collide). Dedup key is `url || title`.
 */
export function mergeSources(
  ...lists: ReadonlyArray<readonly SourcesPartItem[]>
): SourcesPartItem[] {
  const seen = new Set<string>()
  const out: SourcesPartItem[] = []
  for (const list of lists) {
    for (const s of list) {
      const key = s.url || s.title
      if (seen.has(key)) continue
      seen.add(key)
      out.push(s)
    }
  }
  return out
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (typeof s !== "string") return undefined
  const trimmed = s.trim()
  if (!trimmed) return undefined
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1).trimEnd() + "…"
}
