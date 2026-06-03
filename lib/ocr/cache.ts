/**
 * High-level cache helpers used by `lib/ocr/index.ts:extract()`.
 *
 * Translates between the JSON-on-disk row shape (`OcrResultRow`) and the
 * in-memory `OcrResult`. Implements the read-through + write-back logic so
 * the public surface stays a one-liner per code path.
 */

import {
  buildOcrCacheId,
  decodeOcrResult,
  encodeOcrResult,
  getOcrCacheRow,
  putOcrCacheRow,
  type OcrResultRow,
} from "@/lib/db/ocr-results"
import type { OcrPage, OcrResult } from "@/types/ocr"

export interface CacheLookupKey {
  fileSha: string
  providerId: string
  languages: readonly string[]
}

/** Read a cached OcrResult, or null when the row is missing / unreadable. */
export async function readCachedResult(key: CacheLookupKey): Promise<OcrResult | null> {
  const id = buildOcrCacheId(key.fileSha, key.providerId, key.languages)
  const row = await getOcrCacheRow(id)
  if (!row) return null
  return decodeOcrResult(row.result)
}

export interface CacheWriteInput extends CacheLookupKey {
  result: OcrResult
  bytesIn: number
}

/** Store a fresh OcrResult under the canonical cache id. */
export async function writeCachedResult(input: CacheWriteInput): Promise<void> {
  const id = buildOcrCacheId(input.fileSha, input.providerId, input.languages)
  const row: OcrResultRow = {
    id,
    fileSha: input.fileSha,
    providerId: input.providerId,
    langs: [...input.languages]
      .map((l) => l.toLowerCase())
      .sort()
      .join(","),
    result: encodeOcrResult(input.result),
    createdAt: Date.now(),
    bytesIn: input.bytesIn,
  }
  await putOcrCacheRow(row)
}

// ─── Per-page cache (ADR-0024 Phase 2 / 2e — streaming large PDFs) ───────────
// Reuses the same `ocrResults` table (no schema bump) with a page-suffixed id,
// so a large-PDF run resumes from whatever pages already landed.

export interface PageCacheKey extends CacheLookupKey {
  pageNumber: number
}

function pageCacheId(key: PageCacheKey): string {
  return `${buildOcrCacheId(key.fileSha, key.providerId, key.languages)}|p${key.pageNumber}`
}

function normalizeLangs(languages: readonly string[]): string {
  return [...languages]
    .map((l) => l.toLowerCase())
    .sort()
    .join(",")
}

/** Read a single cached page, or null when not yet processed. */
export async function readCachedPage(key: PageCacheKey): Promise<OcrPage | null> {
  const row = await getOcrCacheRow(pageCacheId(key))
  if (!row) return null
  const decoded = decodeOcrResult(row.result)
  return decoded?.pages[0] ?? null
}

/** Persist a single page so a later run can resume past it. */
export async function writeCachedPage(
  key: PageCacheKey,
  page: OcrPage,
  bytesIn = 0
): Promise<void> {
  const wrapped: OcrResult = {
    providerId: key.providerId,
    pages: [page],
    combinedMarkdown: page.markdown,
    combinedText: page.text,
    languages: [...key.languages],
    durationMs: 0,
    cached: false,
  }
  const row: OcrResultRow = {
    id: pageCacheId(key),
    fileSha: key.fileSha,
    providerId: key.providerId,
    langs: normalizeLangs(key.languages),
    result: encodeOcrResult(wrapped),
    createdAt: Date.now(),
    bytesIn,
  }
  await putOcrCacheRow(row)
}
