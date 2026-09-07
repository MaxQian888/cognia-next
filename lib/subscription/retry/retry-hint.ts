// Server-suggested retry delay extraction for the subscription / quota layer.
//
// Why this exists when `extractRetryAfterMs`
// (`@cognia/provider-routing/error-classifier`) already parses retry hints:
// that helper reads four narrow patterns out of a *message string*, because the
// sidecar hands the routing path nothing else. The subscription transport
// (`subscription_authed_request`) returns the real `status + headers + body`,
// and the quota endpoints put their timing almost everywhere except a plain
// `Retry-After`. They use `retry-after-ms`, `x-ratelimit-reset{,-ms,-after}`,
// or free text in the body ("Your limit will reset at 2026-09-01 09:44:51",
// "您的限额将在 2026-09-01 09:44:51 重置", "quota will reset after 18h31m10s").
//
// Dropping those signals is the difference between waiting the two hours the
// server asked for and re-hitting a still-blocked credential eight times inside
// that window, which is exactly what gets a subscription account flagged. So
// this module reads every signal the response carries, and when several
// disagree it honors the LONGEST. Retrying before the widest window clears just
// burns the retry budget against a credential that is still blocked.
//
// The text patterns follow the same shape as the message parser in
// `@cognia/provider-routing`. Each is anchored to an explicit retry or reset
// phrase so an arbitrary number in an error body is never read as a delay.

/** Largest hint we honor before treating the value as hostile or garbage. */
export const MAX_RETRY_HINT_MS = 24 * 60 * 60 * 1000

/** Header bag shapes the subscription transport and `fetch` produce. */
export type RetryHintHeaders =
  Headers | ReadonlyArray<{ name: string; value: string }> | Readonly<Record<string, string>>

// "quota will reset after 1h2m3s" / "10m15s" / "39s"
const QUOTA_RESET_AFTER = /reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i
// "Please retry in 250ms" / "Please retry in 12s"
const PLEASE_RETRY_IN = /please retry in\s+([0-9.]+)\s*(ms|s|sec|seconds?)\b/i
// JSON error detail: "retryDelay": "34.07s"
const RETRY_DELAY_FIELD = /"retry_?delay"\s*:\s*"?([0-9.]+)\s*(ms|s)"?/i
// "try again in 12s" / "try again in ~158 min." / "try again in 1 hour"
const TRY_AGAIN_IN = /try again in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i
// "Your limit will reset in 13 minutes" / "will reset in 2h"
const WILL_RESET_IN =
  /(?:will\s+)?reset in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i
// "Your limit will reset at 2026-09-01 09:44:51" / "resets_at":"2026-09-01T09:44:51Z"
const WILL_RESET_AT =
  /(?:reset(?:s)?[_ ]?at)["'\s:]{0,4}([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)/i
// "您的限额将在 2026-09-01 09:44:51 重置" from Zhipu and other CN coding plans.
const CN_RESET_AT = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})\s*重置/
// "retry-after-ms=98497000" folded into a body string.
const RETRY_AFTER_MS_IN_BODY = /\bretry-after-ms\s*[:=]\s*([0-9]+)\b/i

function unitToMs(unit: string | undefined): number | undefined {
  switch ((unit ?? "s").toLowerCase()) {
    case "ms":
      return 1
    case "s":
    case "sec":
    case "second":
    case "seconds":
      return 1000
    case "m":
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return 60_000
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return 60 * 60_000
    default:
      return undefined
  }
}

/** Normalize any supported header bag to a lowercase-keyed lookup. */
function headerLookup(headers: RetryHintHeaders | undefined): (name: string) => string | undefined {
  if (!headers) return () => undefined
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return (name) => headers.get(name) ?? undefined
  }
  const map = new Map<string, string>()
  if (Array.isArray(headers)) {
    for (const entry of headers) map.set(entry.name.toLowerCase(), entry.value)
  } else {
    for (const [name, value] of Object.entries(headers as Record<string, string>)) {
      map.set(name.toLowerCase(), value)
    }
  }
  return (name) => map.get(name.toLowerCase())
}

/**
 * Read the retry delay out of response headers. Checked in order of how
 * explicit the signal is: an outright millisecond delta beats a seconds delta,
 * which beats a reset counter we have to difference against the clock.
 *
 * Returns `0` when the provider explicitly asks for an immediate retry (an
 * explicit `retry-after: 0`, or a reset stamp that already elapsed). That must
 * survive as `0` rather than collapse to `undefined`, because callers
 * substitute a conservative default when no hint was found, which would sleep a
 * credential the server just told us to retry.
 */
export function retryHintFromHeaders(
  headers: RetryHintHeaders | undefined,
  now: number
): number | undefined {
  const get = headerLookup(headers)

  const retryAfterMs = get("retry-after-ms")
  if (retryAfterMs !== undefined) {
    const ms = Number(retryAfterMs)
    if (Number.isFinite(ms) && ms >= 0) return clampHint(ms)
  }

  const retryAfter = get("retry-after")
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return clampHint(Math.max(0, seconds * 1000))
    const parsed = Date.parse(retryAfter)
    if (!Number.isNaN(parsed)) return clampHint(Math.max(0, parsed - now))
  }

  // A reset that has already elapsed is the provider saying "retry now", and
  // every branch below returns it as `0` rather than falling through. Falling
  // through answers `undefined`, which the caller reads as "no hint" and
  // replaces with its own ramp, so an expired window used to buy a 30 minute
  // block on a credential the server had just freed.
  const resetMs = get("x-ratelimit-reset-ms")
  if (resetMs !== undefined) {
    const value = Number(resetMs)
    if (Number.isFinite(value) && value >= 0) {
      // Above 1e12 the value is epoch ms, above 1e9 it is epoch seconds,
      // otherwise it is already a delta.
      const targetMs = value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined
      if (targetMs === undefined) return clampHint(value)
      return clampHint(Math.max(0, targetMs - now))
    }
  }

  const reset = get("x-ratelimit-reset")
  if (reset !== undefined) {
    const resetSeconds = Number.parseInt(reset, 10)
    if (!Number.isNaN(resetSeconds)) return clampHint(Math.max(0, resetSeconds * 1000 - now))
  }

  const resetAfter = get("x-ratelimit-reset-after")
  if (resetAfter !== undefined) {
    const seconds = Number(resetAfter)
    if (Number.isFinite(seconds)) return clampHint(Math.max(0, seconds * 1000))
  }

  // Anthropic's unified rate-limit headers name the reset as an absolute
  // stamp rather than a delta. It is the same field the usage parser reads.
  const unifiedReset = get("anthropic-ratelimit-unified-reset")
  if (unifiedReset !== undefined) {
    const asSeconds = Number(unifiedReset)
    const targetMs = Number.isFinite(asSeconds) ? asSeconds * 1000 : Date.parse(unifiedReset)
    if (!Number.isNaN(targetMs)) return clampHint(Math.max(0, targetMs - now))
  }

  return undefined
}

/**
 * Read every timing signal a response body carries and return the longest.
 * A body can name several at once (a per-minute throttle AND the account
 * window it sits inside). Waiting only the shorter one walks straight back
 * into the longer block.
 */
export function retryHintFromBody(body: string | undefined, now: number): number | undefined {
  if (!body) return undefined

  let longest: number | undefined
  // A parsed-but-non-positive signal is a provider "retry now". It must not be
  // reported as "no hint found" (see `retryHintFromHeaders`).
  let retryNow = false
  const consider = (ms: number | undefined): void => {
    if (ms === undefined || !Number.isFinite(ms)) return
    if (ms <= 0) {
      retryNow = true
      return
    }
    if (longest === undefined || ms > longest) longest = ms
  }

  const quota = QUOTA_RESET_AFTER.exec(body)
  if (quota) {
    const hours = quota[1] ? Number.parseInt(quota[1], 10) : 0
    const minutes = quota[2] ? Number.parseInt(quota[2], 10) : 0
    const seconds = Number.parseFloat(quota[3] ?? "0")
    if (!Number.isNaN(seconds)) consider(((hours * 60 + minutes) * 60 + seconds) * 1000)
  }

  for (const pattern of [WILL_RESET_AT, CN_RESET_AT]) {
    const match = pattern.exec(body)
    if (!match?.[1]) continue
    // A stamp without an explicit offset is read as UTC, matching how the
    // usage parsers already treat provider timestamps.
    const normalized = match[1].replace(" ", "T")
    const hasOffset = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(normalized)
    const parsed = Date.parse(hasOffset ? normalized : `${normalized}Z`)
    if (!Number.isNaN(parsed)) consider(parsed - now)
  }

  const retryAfterMs = RETRY_AFTER_MS_IN_BODY.exec(body)
  if (retryAfterMs?.[1]) consider(Number(retryAfterMs[1]))

  for (const pattern of [WILL_RESET_IN, PLEASE_RETRY_IN, RETRY_DELAY_FIELD, TRY_AGAIN_IN]) {
    const match = pattern.exec(body)
    if (!match?.[1]) continue
    const value = Number.parseFloat(match[1])
    const unit = unitToMs(match[2])
    if (Number.isFinite(value) && unit !== undefined) consider(value * unit)
  }

  if (longest !== undefined) return clampHint(longest)
  return retryNow ? 0 : undefined
}

export interface RetryHintInput {
  headers?: RetryHintHeaders
  body?: string
  /** Epoch ms. Injected so the absolute-stamp branches stay deterministic. */
  now: number
}

/**
 * The delay the server asked for, in ms, or `undefined` when it asked for
 * nothing. Headers and body are both consulted and the LONGEST wins. A header
 * naming the per-minute bucket must not shorten an account window that the
 * body spells out.
 */
export function extractRetryHintMs(input: RetryHintInput): number | undefined {
  const fromHeaders = retryHintFromHeaders(input.headers, input.now)
  const fromBody = retryHintFromBody(input.body, input.now)
  if (fromHeaders === undefined) return fromBody
  if (fromBody === undefined) return fromHeaders
  return Math.max(fromHeaders, fromBody)
}

function clampHint(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(MAX_RETRY_HINT_MS, Math.round(value))
}
