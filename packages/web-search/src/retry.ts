/**
 * Retry primitives for the unified search service.
 *
 * Provider adapters throw `Error("<Provider> API error: <status> - <body>")`
 * (re-wrapped as `"<Provider> search failed: ..."`), so the HTTP status is
 * carried in the message rather than on a structured field. This module
 * classifies such errors to decide whether an attempt is worth retrying (and
 * whether rotating to a different API key is the right remedy) and computes an
 * exponential-backoff delay. Pure + framework-agnostic (rng/clock injectable)
 * so it unit-tests cleanly.
 */

export interface RetryClassification {
  /** Transient failure — retrying (same or next key) may succeed. */
  retryable: boolean
  /**
   * The current key looks exhausted or rejected (rate-limit / auth), so the
   * best remedy is a *different* key. Still retryable on the same key after
   * backoff when no other key is available.
   */
  rotateKey: boolean
  /** Parsed HTTP status when one could be determined. */
  status?: number
}

/**
 * Extract an HTTP status code from a thrown error, checking structured fields
 * first (`status` / `statusCode` / `response.status`) and then the message.
 * Adapters embed the status as `"... API error: <status> - ..."`, so a status
 * that appears right after an `error`/`status`/`http` token is strongly
 * preferred over any other 3-digit run in the body.
 */
export function extractHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const e = error as {
      status?: unknown
      statusCode?: unknown
      response?: { status?: unknown }
    }
    for (const c of [e.status, e.statusCode, e.response?.status]) {
      if (typeof c === "number" && c >= 100 && c < 600) return c
    }
  }

  const msg = error instanceof Error ? error.message : String(error ?? "")
  // Prefer a status adjacent to an error/status/http marker (adapter format).
  const marked = msg.match(/(?:error|status|http)[^\d]{0,6}([1-5]\d\d)\b/i)
  if (marked) return Number(marked[1])
  // Fall back to any 4xx/5xx run in the message.
  const any = msg.match(/\b([45]\d\d)\b/)
  if (any) return Number(any[1])
  // Keyword fallbacks when the provider only sends prose.
  if (/rate.?limit|too many requests|quota/i.test(msg)) return 429
  if (/unauthorized|invalid api key|invalid.?key|forbidden|401|403/i.test(msg)) return 401
  return undefined
}

/** Message signatures of genuinely transient network/timeout failures. */
const TRANSIENT_NETWORK_RE =
  /(?:failed to fetch|fetch failed|network(?:\s*error)?|timed?\s*out|timeout|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang ?up|temporarily unavailable|service unavailable|connection (?:reset|refused|closed))/i

/**
 * Classify a search error to drive the retry loop. Deliberately conservative:
 * only retry when there is positive evidence the failure is transient, so a hard
 * provider failure falls straight through to the next provider (fallback) instead
 * of costing N wasteful same-provider retries.
 * - 429 / 401 / 403 → retryable, prefer a different key (over quota / rejected)
 * - 408 / 5xx → retryable on the same key (server hiccup)
 * - recognizable network/timeout message → retryable
 * - anything else (other 4xx, unknown errors, aborts) → not retryable
 */
export function classifySearchError(error: unknown): RetryClassification {
  const status = extractHttpStatus(error)
  if (status !== undefined) {
    if (status === 429 || status === 401 || status === 403) {
      return { retryable: true, rotateKey: true, status }
    }
    if (status === 408 || status >= 500) {
      return { retryable: true, rotateKey: false, status }
    }
    // Any other client error (400/404/422/…) won't be fixed by retrying.
    return { retryable: false, rotateKey: false, status }
  }
  const msg = error instanceof Error ? error.message : String(error ?? "")
  if (/abort/i.test(msg)) {
    // A caller-driven abort is not a transient error — do not retry through it.
    return { retryable: false, rotateKey: false }
  }
  if (TRANSIENT_NETWORK_RE.test(msg)) {
    return { retryable: true, rotateKey: false }
  }
  return { retryable: false, rotateKey: false }
}

export interface BackoffOptions {
  /** First-retry base delay in ms (default 300). */
  baseMs?: number
  /** Upper bound per delay in ms (default 4000). */
  maxMs?: number
  /** Growth factor per attempt (default 2). */
  factor?: number
  /** Apply full jitter (default true). */
  jitter?: boolean
  /** Injectable RNG for deterministic tests. */
  random?: () => number
}

/**
 * Exponential backoff with full jitter for a 0-based retry attempt index.
 * `attempt` 0 → ~baseMs, 1 → ~2×baseMs, … capped at `maxMs`.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 300, maxMs = 4000, factor = 2, jitter = true, random = Math.random } = opts
  const capped = Math.min(maxMs, baseMs * Math.pow(factor, Math.max(0, attempt)))
  if (!jitter) return Math.round(capped)
  // Full jitter in [capped/2, capped] keeps a sensible floor while spreading load.
  return Math.floor(capped * (0.5 + random() * 0.5))
}

/**
 * Promise-based sleep that rejects with an `AbortError`-shaped error if the
 * provided signal aborts first. Zero/negative delays resolve on the microtask.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    if (ms <= 0) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
