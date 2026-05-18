/**
 * OCR result cache (Dexie table `ocrResults`, schema v36).
 *
 * Identity key: `sha256(file) | providerId | sortedLangs.join(",")`. The same
 * image + provider + language combo always lands on the same row.
 *
 * Stored result blobs are kept as JSON strings to dodge structured-clone
 * overhead — pages can carry block arrays in the hundreds.
 */

import { getDb } from "./schema"
import type { OcrResult } from "@/lib/ocr/types"

export interface OcrResultRow {
  /** `${fileSha}|${providerId}|${langs}`. */
  id: string
  fileSha: string
  providerId: string
  /** Comma-joined sorted language list — empty string when none. */
  langs: string
  /** JSON-encoded {@link OcrResult} (with `cached:false` flipped at write time). */
  result: string
  /** Epoch ms the row was created. Indexed for TTL cleanup. */
  createdAt: number
  /** Cached input byte count — used by the "clear cache" stats. */
  bytesIn: number
}

/**
 * Build the canonical row id from its parts. Languages are normalized to
 * lowercase + sorted so `["EN","zh"]` collides with `["zh","en"]`.
 */
export function buildOcrCacheId(
  fileSha: string,
  providerId: string,
  langs: readonly string[] | undefined
): string {
  const normalized = (langs ?? []).map((l) => l.toLowerCase()).sort()
  return `${fileSha}|${providerId}|${normalized.join(",")}`
}

export async function getOcrCacheRow(id: string): Promise<OcrResultRow | null> {
  return (await getDb().ocrResults.get(id)) ?? null
}

export async function putOcrCacheRow(row: OcrResultRow): Promise<void> {
  await getDb().ocrResults.put(row)
}

export async function deleteOcrCacheRow(id: string): Promise<void> {
  await getDb().ocrResults.delete(id)
}

export async function clearOcrCache(): Promise<number> {
  const db = getDb()
  const count = await db.ocrResults.count()
  await db.ocrResults.clear()
  return count
}

export async function clearOcrCacheForProvider(providerId: string): Promise<number> {
  const db = getDb()
  const matching = await db.ocrResults.where("providerId").equals(providerId).primaryKeys()
  if (matching.length === 0) return 0
  await db.ocrResults.bulkDelete(matching)
  return matching.length
}

/**
 * Remove rows older than {@param ttlMs}. `ttlMs <= 0` is treated as "never
 * expire" and returns 0 without touching the table.
 */
export async function purgeOcrCacheOlderThan(
  ttlMs: number,
  now: number = Date.now()
): Promise<number> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 0
  const cutoff = now - ttlMs
  const db = getDb()
  const stale = await db.ocrResults.where("createdAt").below(cutoff).primaryKeys()
  if (stale.length === 0) return 0
  await db.ocrResults.bulkDelete(stale)
  return stale.length
}

/** Number of rows + total bytesIn — surfaced in the settings page header. */
export async function ocrCacheStats(): Promise<{ count: number; bytes: number }> {
  const db = getDb()
  let count = 0
  let bytes = 0
  await db.ocrResults.each((row) => {
    count++
    bytes += row.bytesIn
  })
  return { count, bytes }
}

/**
 * Wrap an `OcrResult` for storage. Forces `cached:false` on the stored copy so
 * the loader is free to flip it on without re-encoding.
 */
export function encodeOcrResult(result: OcrResult): string {
  const normalized: OcrResult = { ...result, cached: false }
  return JSON.stringify(normalized)
}

/** Parse a stored OcrResult and flip `cached:true`. Returns null on parse error. */
export function decodeOcrResult(encoded: string): OcrResult | null {
  try {
    const parsed = JSON.parse(encoded) as OcrResult
    return { ...parsed, cached: true }
  } catch {
    return null
  }
}
