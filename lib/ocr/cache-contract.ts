/**
 * OCR cache contract — the injection seam between the pure extract pipeline and
 * whatever actually persists results.
 *
 * `extract()` (result-level) and the streaming PDF path (page-level) used to
 * import the Dexie-backed helpers in `./cache` directly, which welded the core
 * pipeline to `@/lib/db/ocr-results`. They now take an `OcrResultCache` /
 * `OcrPageCache` through `ExtractDeps`, so the pipeline can move into
 * `@cognia/ocr` while the Dexie implementation stays app-side in `./cache`.
 *
 * Both deps are REQUIRED on `ExtractDeps` on purpose: an optional cache would
 * let a missed construction site silently stop persisting OCR output. Callers
 * that genuinely want no persistence must say so with `createNullOcrCache()`.
 */

import type { OcrPage, OcrResult } from "@/types/ocr"

export interface CacheLookupKey {
  fileSha: string
  providerId: string
  languages: readonly string[]
}

export interface CacheWriteInput extends CacheLookupKey {
  result: OcrResult
  bytesIn: number
}

export interface PageCacheKey extends CacheLookupKey {
  pageNumber: number
}

/** Whole-result read-through cache used by `extract()`. */
export interface OcrResultCache {
  /** Cached result, or null on miss / unreadable row. */
  read(key: CacheLookupKey): Promise<OcrResult | null>
  /** Store a fresh result under the canonical cache id. */
  write(input: CacheWriteInput): Promise<void>
}

/** Per-page cache used by the streaming large-PDF path so runs can resume. */
export interface OcrPageCache {
  /** Cached page, or null when that page hasn't been processed yet. */
  read(key: PageCacheKey): Promise<OcrPage | null>
  /** Persist one page so a later run resumes past it. */
  write(key: PageCacheKey, page: OcrPage, bytesIn?: number): Promise<void>
}

/**
 * Explicit "do not persist" cache. Use in tests and in callers that must not
 * write OCR output to disk — never as a fallback for a forgotten wiring, which
 * is exactly the silent degradation the required deps are meant to prevent.
 */
export function createNullOcrCache(): OcrResultCache {
  return {
    async read() {
      return null
    },
    async write() {
      // intentionally no-op
    },
  }
}

/** Page-level counterpart to {@link createNullOcrCache}. */
export function createNullOcrPageCache(): OcrPageCache {
  return {
    async read() {
      return null
    },
    async write() {
      // intentionally no-op
    },
  }
}
