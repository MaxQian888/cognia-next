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

/** Whether a class is worth retrying against another main-chain provider. */
export function isTransientErrorClass(errorClass: ProviderErrorClass): boolean {
  return TRANSIENT_ERROR_CLASSES.has(errorClass)
}

export type { ProviderErrorClass }
