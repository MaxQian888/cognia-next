/**
 * Exponential backoff + jitter — shared formula for the two independent
 * retry mechanisms in cognia-next's scheduled-task subsystem:
 *
 *   - `lib/scheduler/task-scheduler.ts`'s task-level retry (ratio jitter,
 *     added BEFORE the max-delay cap).
 *   - `lib/connectors/outbound-runner.ts`'s delivery-level retry (absolute
 *     jitter, added AFTER the cap).
 *
 * These two shapes are genuinely different (see `BackoffJitter` below) and
 * are not meant to converge — only the exponential-delay arithmetic is
 * shared, so a future tuning of one caller can't silently drift out of sync
 * with the other's formula.
 */

export type BackoffJitter =
  | { kind: "ratio"; ratio: number; rng?: () => number }
  | { kind: "absolute"; amountMs: () => number }

export interface BackoffOptions {
  baseDelayMs: number
  maxDelayMs: number
  jitter: BackoffJitter
}

/**
 * Compute `attempt`'s backoff delay (ms). `attempt` is 0-indexed (the delay
 * before the first retry uses `attempt = 0`).
 *
 * - `{kind: "ratio"}`: `min(exponential + rng()*exponential*ratio, maxDelayMs)`
 *   — jitter scales with the exponential term and is capped together with it.
 * - `{kind: "absolute"}`: `min(maxDelayMs, exponential) + amountMs()` — a flat
 *   jitter amount added after the cap, so the true max is `maxDelayMs + amountMs()`.
 */
export function computeBackoffDelay(attempt: number, opts: BackoffOptions): number {
  const exponential = opts.baseDelayMs * Math.pow(2, attempt)
  if (opts.jitter.kind === "ratio") {
    const rng = opts.jitter.rng ?? Math.random
    return Math.min(exponential + rng() * exponential * opts.jitter.ratio, opts.maxDelayMs)
  }
  return Math.min(opts.maxDelayMs, exponential) + opts.jitter.amountMs()
}
