/**
 * Pure retry math for the twin job worker.
 *
 * Kept as standalone functions (no Dexie / no clock dependency) so the
 * worker can stay a thin orchestration layer and these helpers are
 * trivially unit-testable. The worker calls `shouldRetry` after a job
 * failure to decide between requeue and dead-letter, and `backoffMs` to
 * compute the wait until the next attempt.
 */

/** After this many failed attempts the job is dead-lettered. */
export const MAX_RETRIES = 3

/** Cap on the exponential — keeps long-tail retries from sleeping forever. */
export const MAX_BACKOFF_MS = 60_000

/** Base step — first retry waits ~1s, second ~2s, third ~4s, capped at 60s. */
const BASE_BACKOFF_MS = 1_000

/**
 * Exponential backoff with random jitter [0, 500ms).
 *
 * `attempt` is 1-indexed: pass `1` for the wait before retry #1, `2` for
 * retry #2, etc. The jitter helps avoid thundering-herd retries when many
 * jobs fail at the same instant (e.g. an embedding API outage).
 *
 * @param attempt    1-indexed retry attempt
 * @param random     injectable randomness for deterministic tests; defaults
 *                   to `Math.random`
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  if (!Number.isFinite(attempt) || attempt < 1) return BASE_BACKOFF_MS
  const exp = BASE_BACKOFF_MS * Math.pow(2, attempt - 1)
  const capped = Math.min(MAX_BACKOFF_MS, exp)
  const jitter = Math.floor(random() * 500)
  return capped + jitter
}

/**
 * Returns true when the next attempt should be enqueued, false when the
 * job has exhausted its budget and should be dead-lettered. The worker is
 * responsible for atomically incrementing `retryCount` before consulting
 * this; we treat the value as "retries already performed".
 */
export function shouldRetry(retryCount: number, max: number = MAX_RETRIES): boolean {
  if (!Number.isFinite(retryCount) || retryCount < 0) return false
  return retryCount < max
}

/**
 * Format a dead-letter error message with a sentinel prefix so the UI /
 * audit log can detect dead-letters cheaply.
 */
export function formatDeadLetter(originalMessage: string, attempts: number): string {
  return `dead-letter: ${originalMessage} (after ${attempts} attempts)`
}

/** Return value of `parseDeadLetter`; null when the message isn't dead-lettered. */
export interface DeadLetterInfo {
  message: string
  attempts: number
}

/**
 * Reverse of `formatDeadLetter`. Returns null for messages that don't carry
 * the sentinel — useful for UI components that want to render dead-lettered
 * jobs differently from transient failures.
 */
export function parseDeadLetter(errorMessage: string | undefined): DeadLetterInfo | null {
  if (!errorMessage) return null
  const match = errorMessage.match(/^dead-letter: (.*) \(after (\d+) attempts\)$/)
  if (!match) return null
  return { message: match[1], attempts: parseInt(match[2], 10) }
}
