/**
 * Boundary shim — the implementation moved into `@cognia/ocr` (the pure,
 * dependency-injected OCR core). Kept so existing `@/lib/ocr/index` importers and
 * the app-side composition roots (runtime.ts, deps.ts, cache.ts, credentials.ts)
 * stay unchanged.
 *
 * `extract` is re-exported through a metering wrapper rather than passed
 * straight through. OCR is billed per page (or per image, or per token) by
 * every cloud provider and was metered nowhere: a hundred-page PDF cost real
 * money and left the Usage tab unchanged. The wrapper lives here, not in the
 * package, because `@cognia/ocr` is one of the zero-`@/` standalone builds
 * (`pnpm build:packages`) and cannot reach the app's Dexie layer.
 */
import { extract as extractCore, type ExtractDeps } from "@cognia/ocr"
// `@cognia/ocr`'s root re-exports the types it uses but does not re-export
// `OcrInput` / `OcrResult` themselves; the subpath is where they live.
import type { OcrInput, OcrResult } from "@cognia/ocr/types"

import { recordSurfaceUsage, swallowUsageWrite } from "@/lib/db/session-usage"

export * from "@cognia/ocr"

/**
 * Run OCR and meter what it billed.
 *
 * A CACHED result is not metered: it cost nothing this time, and counting it
 * would make the same document look more expensive every time it is re-read.
 */
export async function extract(input: OcrInput, deps: ExtractDeps): Promise<OcrResult> {
  const result = await extractCore(input, deps)
  if (!result.cached && result.pages.length > 0) {
    swallowUsageWrite(
      recordSurfaceUsage({
        surface: "ocr",
        // Same provider + languages + output is the same billable extraction,
        // so a re-run that missed the cache overwrites instead of double-billing.
        operationId: ocrOperationId(result),
        scopeId: result.providerId,
        usage: {
          providerId: result.providerId,
          durationMs: result.durationMs,
          // The provider's own USD projection when it made one. Absent means
          // unpriced, NOT free — `costSource` says which.
          ...(typeof result.costEstimate?.amount === "number"
            ? { costUsd: result.costEstimate.amount, costSource: "sdk", costKnown: true }
            : { costSource: "unknown", costKnown: false }),
          unitBreakdown: { pages: result.pages.length },
        },
      })
    )
  }
  return result
}

/**
 * Stable id for one extraction.
 *
 * `extract` does not return the file digest it computed internally, so the id
 * is derived from what the result does expose: the provider, the language set,
 * the page count, and a digest of the produced text. Two runs over the same
 * document with the same settings produce the same id, which is exactly the
 * idempotency the billing table needs.
 */
function ocrOperationId(result: OcrResult): string {
  const digest = fnv1a(`${result.combinedText}`)
  return `${result.providerId}:${result.languages.join("+")}:${result.pages.length}:${digest}`
}

/** 32-bit FNV-1a. An opaque correlation ref, not a security digest. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}
