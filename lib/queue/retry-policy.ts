/**
 * Retry policy for the mobile outbound queue (Wave 2.1).
 *
 * Pure functions — no clock or scheduler. The runner consumes these to
 * decide when (or whether) to retry a failed row.
 */

/** Maximum retry count before a row is moved to deadletter. */
export const MAX_ATTEMPTS = 5

/**
 * A caller-declared retry narrowing. Every value can only make a row give up
 * sooner (`maxAttempts`) or wait longer (`baseDelayMs`/`maxDelayMs`) than the
 * host default — a policy asks for patience or resignation, never for more
 * work than the host's own ceiling allows.
 */
export interface RetryPolicyOverride {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

/**
 * Exponential backoff with jitter, capped at 60 s.
 *
 *   attempt 1 → ~1 s
 *   attempt 2 → ~2 s
 *   attempt 3 → ~4 s
 *   attempt 4 → ~8 s
 *   attempt 5 → ~16 s
 *
 * `random` is injected so tests can assert deterministic delays. A `policy`
 * can only widen the delays: the effective base and cap are the LARGER of the
 * default and the declared value.
 */
export function backoffDelayMs(
  attempt: number,
  random: () => number = Math.random,
  policy?: Pick<RetryPolicyOverride, "baseDelayMs" | "maxDelayMs">
): number {
  const safeAttempt = Math.max(1, attempt)
  const baseDelay = Math.max(1_000, policy?.baseDelayMs ?? 1_000)
  const maxDelay = Math.max(60_000, policy?.maxDelayMs ?? 60_000)
  const base = Math.min(maxDelay, baseDelay * 2 ** (safeAttempt - 1))
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
  /** Declared narrowing; absent means the host defaults, unchanged. */
  policy?: RetryPolicyOverride
}): NextAttemptDecision {
  const { attempts, error, nowMs = Date.now(), random, policy } = opts
  const msg = error instanceof Error ? error.message : String(error)
  const nextAttempts = attempts + 1
  // A declared budget can only shrink the host's, and never below one shot.
  const maxAttempts = Math.max(1, Math.min(MAX_ATTEMPTS, policy?.maxAttempts ?? MAX_ATTEMPTS))
  if (!isRetryable(error) || nextAttempts >= maxAttempts) {
    return {
      status: "deadlettered",
      nextAttemptAt: nowMs,
      attempts: nextAttempts,
      lastError: msg,
    }
  }
  return {
    status: "pending",
    nextAttemptAt: nowMs + backoffDelayMs(nextAttempts, random, policy),
    attempts: nextAttempts,
    lastError: msg,
  }
}
