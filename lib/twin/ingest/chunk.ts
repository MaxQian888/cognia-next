/**
 * Chunking adapter for the twin ingest pipeline.
 *
 * Wraps `lib/ai/embedding/chunking.ts` so callers don't have to know the
 * eight strategies — this module picks one based on the source `format`
 * (markdown → heading, code → code, chat → paragraph, etc.) and returns
 * the chunks shaped for the persist step (offsets + token counts +
 * format-specific metadata).
 */

import {
  chunkDocument,
  type ChunkingOptions,
  type ChunkingStrategy,
} from "@cognia/provider-embedding/chunking"
import type {
  ChunkingStrategyId,
  TwinBoundingBox,
  TwinChunkMetadata,
  TwinPageMapEntry,
  TwinSourceFormat,
} from "@/types/twin"
import { estimateFallbackTokens } from "@/lib/ai/tokens/fallback-estimator"

export interface PreparedChunk {
  /** Strategy actually used (after the format-based picker). */
  strategy: ChunkingStrategyId
  content: string
  /** Char offsets into the parsed (post-redact) text. */
  charStart: number
  charEnd: number
  /** Approximate token count (js-tiktoken style — see `hooks/chat/use-token-count`). */
  tokenCount: number
  /** Extra metadata derived from the chunk content (e.g. headingPath). */
  metadata: TwinChunkMetadata
}

const FORMAT_TO_STRATEGY: Record<TwinSourceFormat, ChunkingStrategy> = {
  markdown: "heading",
  pdf: "smart",
  docx: "heading",
  xlsx: "fixed",
  pptx: "paragraph",
  odt: "heading",
  odp: "paragraph",
  html: "heading",
  csv: "fixed",
  epub: "heading",
  rtf: "paragraph",
  code: "code",
  "chatgpt-export": "paragraph",
  "claude-export": "paragraph",
  "gemini-export": "paragraph",
  "slack-export": "paragraph",
  "lark-export": "paragraph",
  "dingtalk-export": "paragraph",
  "wechat-export": "paragraph",
  mbox: "paragraph",
  eml: "paragraph",
  "git-repo": "code",
}

function approxTokenCount(text: string): number {
  return Math.max(1, estimateFallbackTokens(text))
}

/**
 * Walk a heading-aware chunk's body and infer the header trail so
 * provenance breadcrumbs ("Onboarding › Day 1 › Setup") work in the UI.
 * Conservative: only picks `# ... ###` lines that appear at chunk start.
 */
function inferHeadingPath(content: string): string[] | undefined {
  const lines = content.split("\n").slice(0, 10)
  const headings: string[] = []
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line)
    if (match) headings.push(match[2].trim())
    if (headings.length > 0 && !match) break
  }
  return headings.length > 0 ? headings : undefined
}

export interface ChunkInput {
  /** Already-redacted text (PII placeholders are fine — chunking is text-blind). */
  redactedText: string
  /** Original (non-redacted) text — used to slice the displayable `content`. */
  originalText: string
  format: TwinSourceFormat
  /** Optional per-format metadata that gets merged onto every chunk. */
  baseMetadata?: TwinChunkMetadata
  /** Override the strategy picker. */
  strategy?: ChunkingStrategy
  options?: Partial<ChunkingOptions>
  /**
   * PDF page char ranges in REDACTED space (already translated through
   * `translateOffsetsThroughRedaction`). When present, each chunk gets
   * stamped with `pageNumber` / `pageEnd` / `bboxUnion` provenance.
   */
  pageMap?: TwinPageMapEntry[]
}

function unionBoundingBoxes(boxes: TwinBoundingBox[]): TwinBoundingBox | undefined {
  if (boxes.length === 0) return undefined
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const box of boxes) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Stamp page provenance onto a chunk's metadata from the overlapping
 *  pageMap entries. Mutates `metadata` (a per-chunk copy). */
function stampPageMetadata(
  metadata: TwinChunkMetadata,
  pageMap: TwinPageMapEntry[],
  charStart: number,
  charEnd: number
): void {
  const overlapping = pageMap.filter((page) => page.charStart < charEnd && page.charEnd > charStart)
  if (overlapping.length === 0) return
  metadata.pageNumber = overlapping[0].pageNumber
  const last = overlapping[overlapping.length - 1].pageNumber
  if (last > overlapping[0].pageNumber) {
    metadata.pageEnd = last
  }
  const bboxUnion = unionBoundingBoxes(
    overlapping.flatMap((page) => (page.bboxUnion ? [page.bboxUnion] : []))
  )
  if (bboxUnion) {
    metadata.bboxUnion = bboxUnion
  }
}

export function prepareChunks(input: ChunkInput): PreparedChunk[] {
  const strategy = input.strategy ?? FORMAT_TO_STRATEGY[input.format] ?? "paragraph"
  const result = chunkDocument(input.redactedText, {
    ...input.options,
    strategy,
  })
  return result.chunks.map((c) => {
    const metadata: TwinChunkMetadata = { ...input.baseMetadata }
    if (strategy === "heading") {
      const path = inferHeadingPath(c.content)
      if (path) metadata.headingPath = path
    }
    if (input.pageMap?.length) {
      stampPageMetadata(metadata, input.pageMap, c.startOffset, c.endOffset)
    }
    return {
      strategy: strategy as ChunkingStrategyId,
      content: c.content,
      charStart: c.startOffset,
      charEnd: c.endOffset,
      tokenCount: approxTokenCount(c.content),
      metadata,
    }
  })
}
