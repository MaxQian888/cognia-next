// Extract structured HTTP error metadata from a caught provider/SDK error so
// the renderer's routing classifier + circuit breaker can act on the REAL
// status code and Retry-After header instead of string-matching the message.
//
// Two error shapes are handled:
//   - Anthropic SDK `APIError`         → `.status` (number) + `.headers`
//   - Vercel AI SDK `APICallError`     → `.statusCode` (number) + `.responseHeaders`
//
// Returns `{}` when neither shape is present — the renderer's message-text
// extraction (`error-classifier.extractRetryAfterMs`) remains the fallback.

/** Structured status / retry hints for the renderer's classifier. */
export interface HttpErrorMeta {
  httpStatus?: number
  retryAfterMs?: number
}

/** Read a header case-insensitively from a Headers instance or plain object. */
function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  // Headers / Map-like (has a `.get`).
  const getter = (headers as { get?: unknown }).get
  if (typeof getter === "function") {
    try {
      const get = (key: string): unknown => getter.call(headers, key)
      const v = get(name) ?? get(lower)
      if (typeof v === "string") return v
    } catch {
      // fall through to plain-object scan
    }
  }
  if (typeof headers === "object") {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) {
        const v = (headers as Record<string, unknown>)[key]
        if (typeof v === "string" || typeof v === "number") return String(v)
      }
    }
  }
  return undefined
}

/**
 * Parse a Retry-After header value to milliseconds. Supports the integer
 * delta-seconds form ("30") and the HTTP-date form. Returns undefined for
 * absent / garbage / past values.
 */
export function parseRetryAfterMs(
  value: unknown,
  now: () => number = Date.now
): number | undefined {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text === "") return undefined
  // delta-seconds (most common)
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text)
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
  }
  // HTTP-date
  const ts = Date.parse(text)
  if (Number.isFinite(ts)) {
    const delta = ts - now()
    return delta > 0 ? delta : undefined
  }
  return undefined
}

/**
 * Pull `{ httpStatus?, retryAfterMs? }` off a caught error. Pure; missing
 * fields are simply omitted so the result spreads cleanly into a
 * `session_ended` event.
 */
export function extractHttpErrorMeta(err: unknown, now: () => number = Date.now): HttpErrorMeta {
  const meta: HttpErrorMeta = {}
  if (!err || typeof err !== "object") return meta
  const e = err as {
    status?: unknown
    statusCode?: unknown
    responseHeaders?: unknown
    headers?: unknown
  }
  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.statusCode === "number"
        ? e.statusCode
        : undefined
  if (typeof status === "number" && Number.isFinite(status)) meta.httpStatus = status
  const headers = e.responseHeaders ?? e.headers
  const retryAfterMs = parseRetryAfterMs(readHeader(headers, "retry-after"), now)
  if (retryAfterMs !== undefined) meta.retryAfterMs = retryAfterMs
  return meta
}
