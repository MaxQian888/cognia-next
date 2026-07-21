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
import type {
  CacheLookupKey,
  CacheWriteInput,
  OcrPageCache,
  OcrResultCache,
  PageCacheKey,
} from "./cache-contract"

// The key/input shapes are part of the injection contract (they travel with the
// pipeline into `@cognia/ocr`); this module keeps the Dexie-backed behaviour.
export type { CacheLookupKey, CacheWriteInput, PageCacheKey } from "./cache-contract"

/** Read a cached OcrResult, or null when the row is missing / unreadable. */
export async function readCachedResult(key: CacheLookupKey): Promise<OcrResult | null> {
  const id = buildOcrCacheId(key.fileSha, key.providerId, key.languages)
  const row = await getOcrCacheRow(id)
  if (!row) return null
  return decodeOcrResult(row.result)
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

// ─── Injection-contract adapters ─────────────────────────────────────────────
// The extract pipeline takes these through `ExtractDeps` instead of importing
// this module, so the pipeline carries no Dexie dependency. `buildOcrDeps()`
// wires them by default — production behaviour is unchanged.

/** Dexie-backed whole-result cache. */
export const dexieOcrResultCache: OcrResultCache = {
  read: readCachedResult,
  write: writeCachedResult,
}

/** Dexie-backed per-page cache (streaming large-PDF resume). */
export const dexieOcrPageCache: OcrPageCache = {
  read: readCachedPage,
  write: writeCachedPage,
}
