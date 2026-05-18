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
import type { OcrResult } from "./types"

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
