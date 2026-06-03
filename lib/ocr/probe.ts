/**
 * OCR provider probe — a single-shot health check used by the settings UI
 * when the user clicks "Probe connection" on a provider's detail panel.
 *
 * Runs `extract()` with a 1×1 transparent PNG, `useCache: false`, and the
 * caller-supplied ExtractDeps. Normalizes any thrown error into the same
 * `ProbeOutcome` shape so the UI can render the result with one component.
 *
 * Kept tiny and dependency-injected so unit tests can stub `extract` via the
 * `__extractImpl` parameter without going through the full OCR runtime.
 */

import { extract as defaultExtract, type ExtractDeps } from "./index"
import { OcrError } from "@/lib/ocr/errors"
import { type OcrErrorCode } from "@/types/ocr"

export interface ProbeOutcome {
  /** True when the provider returned a result. */
  ok: boolean
  /** Wall-clock duration of the probe (ms). */
  durationMs: number
  /** Populated only when `ok` is false. */
  error?: { code: OcrErrorCode; message: string }
}

/** 1×1 transparent PNG — 67 bytes, smallest valid PNG. */
export const PROBE_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII="

export interface ProbeOptions {
  /** Tests inject a fake `extract` to keep the probe self-contained. */
  __extractImpl?: typeof defaultExtract
  /** When false, callers can opt out of the cache-miss header. Defaults to true. */
  useCache?: boolean
}

/**
 * Run a one-shot extract against the given provider id. Returns a normalized
 * `ProbeOutcome` whether the call succeeded or failed. Callers should never
 * have to try/catch.
 */
export async function probeOcrProvider(
  providerId: string,
  deps: ExtractDeps,
  opts: ProbeOptions = {}
): Promise<ProbeOutcome> {
  const extractImpl = opts.__extractImpl ?? defaultExtract
  const start = performanceNow()
  try {
    await extractImpl(
      {
        providerId,
        useCache: opts.useCache === undefined ? false : opts.useCache,
        source: {
          kind: "data-url",
          dataUrl: PROBE_PNG_DATA_URL,
          mimeType: "image/png",
        },
      },
      deps
    )
    return { ok: true, durationMs: Math.max(0, performanceNow() - start) }
  } catch (err) {
    return {
      ok: false,
      durationMs: Math.max(0, performanceNow() - start),
      error: toProbeError(err),
    }
  }
}

function toProbeError(err: unknown): { code: OcrErrorCode; message: string } {
  // Duck-type alongside instanceof so cross-module require chains (which
  // happen under Jest) still preserve the OcrError discriminant.
  const looksLikeOcrError =
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    "providerId" in err &&
    (err as { name?: string }).name === "OcrError"
  if (err instanceof OcrError || looksLikeOcrError) {
    const e = err as { code: OcrErrorCode; message: string }
    return { code: e.code, message: e.message }
  }
  return {
    code: "provider_failed",
    message: err instanceof Error ? err.message : String(err),
  }
}

function performanceNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now()
  }
  return Date.now()
}
