/**
 * Provider error classifier — turns the noisy error strings providers and
 * SDKs surface ("HTTPError 429: …", "rate_limit_error", "prompt is too
 * long: 224864 tokens > 200000 maximum", …) into one
 * {@link ProviderErrorClass} the retry paths act on.
 *
 * Ordering matters: the special classes (context-window / content-policy)
 * are matched FIRST because their messages often also contain generic
 * status codes (a context overflow is usually a 400), then permanent
 * classes, then transient ones. Unknown maps to `unknown` and is treated
 * as permanent by callers — a logic bug must not be silently retried
 * across every provider in the chain.
 */

import { TRANSIENT_ERROR_CLASSES, type ProviderErrorClass } from "@/types/provider/error-class"

const CONTEXT_WINDOW_PATTERNS: ReadonlyArray<RegExp> = [
  /context[_ -]?(window|length|limit)/i,
  /maximum context/i,
  /prompt is too long/i,
  /too many tokens/i,
  /input (?:length|tokens?).{0,40}exceed/i,
  /exceeds? .{0,30}(context|token limit)/i,
  /max(?:imum)?[_ ]tokens?.{0,30}exceed/i,
]

const CONTENT_POLICY_PATTERNS: ReadonlyArray<RegExp> = [
  /content[_ -]?(policy|filter|management)/i,
  /policy violation/i,
  /moderation/i,
  /\bflagged\b/i,
  /safety (?:system|filter|setting)/i,
]

const AUTH_PATTERNS: ReadonlyArray<RegExp> = [
  /unauthori[sz]ed/i,
  /invalid[_ ]?api[_ ]?key/i,
  /missing[_ ]credential/i,
  /\b40[13]\b/,
  /authentication/i,
]

const INVALID_REQUEST_PATTERNS: ReadonlyArray<RegExp> = [/invalid[_ ]request/i, /\b400\b/]

const RATE_LIMIT_PATTERNS: ReadonlyArray<RegExp> = [
  /\brate[_ -]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /quota exceeded/i,
]

const TIMEOUT_PATTERNS: ReadonlyArray<RegExp> = [/timed? ?out/i, /ETIMEDOUT/]

const NETWORK_PATTERNS: ReadonlyArray<RegExp> = [
  /\bnetwork\b/i,
  /ECONNRESET|ECONNREFUSED|ENOTFOUND/,
  /fetch failed/i,
]

const SERVER_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /\b5\d\d\b/,
  /provider[_ ]error/i,
  /\boverloaded\b/i,
  /service[_ ]unavailable|\bunavailable\b/i,
  /internal server error/i,
]

const ORDERED: ReadonlyArray<[ProviderErrorClass, ReadonlyArray<RegExp>]> = [
  ["context-window-exceeded", CONTEXT_WINDOW_PATTERNS],
  ["content-policy", CONTENT_POLICY_PATTERNS],
  ["auth", AUTH_PATTERNS],
  ["invalid-request", INVALID_REQUEST_PATTERNS],
  ["rate-limit", RATE_LIMIT_PATTERNS],
  ["timeout", TIMEOUT_PATTERNS],
  ["network", NETWORK_PATTERNS],
  ["server-error", SERVER_ERROR_PATTERNS],
]

/** Classify a provider/SDK error message. */
export function classifyProviderError(message: string): ProviderErrorClass {
  for (const [errorClass, patterns] of ORDERED) {
    if (patterns.some((pattern) => pattern.test(message))) {
      return errorClass
    }
  }
  return "unknown"
}

/** Classification + retry hint extracted from a provider error message. */
export interface ProviderErrorInfo {
  errorClass: ProviderErrorClass
  /**
   * Retry-After hint in milliseconds, extracted from the message text when
   * present. Only populated for `rate-limit` / `server-error` (the classes
   * where providers actually send it); the breaker clamps it via
   * `maxCooldownMs`.
   */
  retryAfterMs?: number
}

/** Classes whose messages may legitimately carry a retry hint. */
const RETRY_HINT_CLASSES: ReadonlySet<ProviderErrorClass> = new Set(["rate-limit", "server-error"])

// Narrow extraction patterns, each anchored to an explicit retry phrase so
// arbitrary numbers in error text are never misread as delays.
const RETRY_AFTER_SECONDS = /retry[_ -]?after[:\s"']{0,4}(\d+(?:\.\d+)?)(?:\s*s(?:econds?)?\b|\b)/i
const TRY_AGAIN_IN =
  /(?:try again|retry) in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?)\b/i
const RETRY_DELAY = /retry[_ -]?delay[:\s"']{0,4}"?(\d+(?:\.\d+)?)\s*(ms|s)?\b/i
const RETRY_AFTER_HTTP_DATE =
  /retry[_ -]?after[:\s"']{0,4}([A-Z][a-z]{2},\s\d{1,2}\s[A-Z][a-z]{2}\s\d{4}\s\d{2}:\d{2}:\d{2}\sGMT)/i

function unitToMs(value: number, unit: string | undefined): number {
  const u = (unit ?? "s").toLowerCase()
  if (u === "ms" || u.startsWith("millisecond")) return value
  if (u === "m" || u.startsWith("minute")) return value * 60_000
  return value * 1000
}

/**
 * Extract a Retry-After hint (ms) from raw error text. Exported for the
 * fallback path; injectable clock keeps the http-date branch deterministic.
 */
export function extractRetryAfterMs(
  message: string,
  now: () => number = Date.now
): number | undefined {
  const httpDate = RETRY_AFTER_HTTP_DATE.exec(message)
  if (httpDate) {
    const ts = Date.parse(httpDate[1])
    if (Number.isFinite(ts)) {
      const delta = ts - now()
      return delta > 0 ? delta : undefined
    }
  }
  const tryAgain = TRY_AGAIN_IN.exec(message)
  if (tryAgain) return unitToMs(Number(tryAgain[1]), tryAgain[2])
  const retryDelay = RETRY_DELAY.exec(message)
  if (retryDelay) return unitToMs(Number(retryDelay[1]), retryDelay[2])
  const seconds = RETRY_AFTER_SECONDS.exec(message)
  if (seconds) return unitToMs(Number(seconds[1]), undefined)
  return undefined
}

/**
 * Classify a provider error AND extract its Retry-After hint when the class
 * may carry one. `classifyProviderError` stays the plain-class wrapper.
 */
export function classifyProviderErrorInfo(
  message: string,
  now: () => number = Date.now
): ProviderErrorInfo {
  const errorClass = classifyProviderError(message)
  if (!RETRY_HINT_CLASSES.has(errorClass)) return { errorClass }
  const retryAfterMs = extractRetryAfterMs(message, now)
  return retryAfterMs !== undefined && retryAfterMs > 0
    ? { errorClass, retryAfterMs }
    : { errorClass }
}

// Deferred stretch (sidecar protocol change + tauri-smoke): forward the real
// `retry-after` HTTP header + status code from sidecar/fetch-interceptor.mjs
// session-scoped into `session_ended` so this string extraction becomes a
// fallback instead of the primary path.

/** Whether a class is worth retrying against another main-chain provider. */
export function isTransientErrorClass(errorClass: ProviderErrorClass): boolean {
  return TRANSIENT_ERROR_CLASSES.has(errorClass)
}

export type { ProviderErrorClass }
