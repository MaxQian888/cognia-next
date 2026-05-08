/**
 * Retry policy for the mobile outbound queue (Wave 2.1).
 *
 * Pure functions — no clock or scheduler. The runner consumes these to
 * decide when (or whether) to retry a failed row.
 */

/** Maximum retry count before a row is moved to deadletter. */
export const MAX_ATTEMPTS = 5

/**
 * Exponential backoff with jitter, capped at 60 s.
 *
 *   attempt 1 → ~1 s
 *   attempt 2 → ~2 s
 *   attempt 3 → ~4 s
 *   attempt 4 → ~8 s
 *   attempt 5 → ~16 s
 *
 * `random` is injected so tests can assert deterministic delays.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Math.max(1, attempt)
  const base = Math.min(60_000, 1_000 * 2 ** (safeAttempt - 1))
  const jitter = base * 0.25 * random()
  return Math.round(base + jitter)
}

/** Sentinel error codes that bypass retries (no point — they'll always fail). */
export const NON_RETRYABLE_PATTERNS: readonly RegExp[] = [
  /\bunauthor(ized|ised)\b/i,
  /\b401\b/,
  /\b403\b/,
  /\bnot.found\b/i,
  /\b404\b/,
  /\bbad.request\b/i,
  /\b400\b/,
  /\bvalidation\b/i,
  /\bschema\b/i,
]

export function isRetryable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return !NON_RETRYABLE_PATTERNS.some((re) => re.test(msg))
}

export interface NextAttemptDecision {
  status: "pending" | "deadlettered"
  nextAttemptAt: number
  attempts: number
  lastError: string
}

/**
 * Compute the next-attempt window after a failed try. Either bumps the
 * attempt counter and schedules retry, or deadletters the row.
 */
export function decideNextAttempt(opts: {
  attempts: number
  error: unknown
  nowMs?: number
  random?: () => number
}): NextAttemptDecision {
  const { attempts, error, nowMs = Date.now(), random } = opts
  const msg = error instanceof Error ? error.message : String(error)
  const nextAttempts = attempts + 1
  if (!isRetryable(error) || nextAttempts >= MAX_ATTEMPTS) {
    return {
      status: "deadlettered",
      nextAttemptAt: nowMs,
      attempts: nextAttempts,
      lastError: msg,
    }
  }
  return {
    status: "pending",
    nextAttemptAt: nowMs + backoffDelayMs(nextAttempts, random),
    attempts: nextAttempts,
    lastError: msg,
  }
}
