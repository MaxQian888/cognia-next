/**
 * Check scheduling arithmetic for the Update Center.
 *
 * Pure by design: the coordinator owns the clock and the persistence, this
 * module only answers "when may I ask again". Every caller passes `now`
 * explicitly so a test never has to fake timers.
 */

/** Base gap after the first failure. */
export const BASE_BACKOFF_MS = 60_000

/** Ceiling on the exponential ramp, independent of the poll interval. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000

/** Fraction of the computed delay that jitter may add. */
export const JITTER_RATIO = 0.2

/** Largest `Retry-After` we honor before treating the server as hostile. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

export interface BackoffInput {
  /** Consecutive failures so far, including the one just observed. */
  consecutiveFailures: number
  /** Normal gap between successful checks. */
  intervalMs: number
  /** Server-supplied hold, already parsed to milliseconds. */
  retryAfterMs?: number
  /** Deterministic 0 to 1 jitter source. Defaults to `Math.random`. */
  random?: () => number
}

/**
 * Delay before the next check. `Retry-After` wins over our own ramp whenever
 * it asks for a longer wait, because a shorter one would let a client that is
 * already being throttled keep hammering the endpoint.
 */
export function backoffDelayMs(input: BackoffInput): number {
  const { consecutiveFailures, intervalMs } = input
  const random = input.random ?? Math.random
  if (consecutiveFailures <= 0) {
    return Math.max(0, Math.round(intervalMs))
  }
  const exponential = Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * Math.pow(2, Math.min(consecutiveFailures - 1, 20))
  )
  const retryAfter = clampRetryAfterMs(input.retryAfterMs)
  const base = Math.max(exponential, retryAfter ?? 0)
  const jitter = base * JITTER_RATIO * random()
  return Math.round(base + jitter)
}

/** Epoch ms of the next permitted check. */
export function nextCheckAt(now: number, input: BackoffInput): number {
  return now + backoffDelayMs(input)
}

/** True when the coordinator is allowed to check `assetId` right now. */
export function isCheckDue(now: number, nextAllowedAt: number | undefined): boolean {
  if (nextAllowedAt === undefined) return true
  return now >= nextAllowedAt
}

/**
 * Parse a `Retry-After` header. Accepts both the delta-seconds and the
 * HTTP-date forms. Returns undefined for anything unparseable rather than
 * guessing, and clamps hostile values to `MAX_RETRY_AFTER_MS`.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number
): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (!trimmed) return undefined
  if (/^\d+$/.test(trimmed)) {
    return clampRetryAfterMs(Number(trimmed) * 1000)
  }
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return undefined
  return clampRetryAfterMs(Math.max(0, parsed - now))
}

function clampRetryAfterMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  return Math.min(MAX_RETRY_AFTER_MS, Math.round(value))
}
