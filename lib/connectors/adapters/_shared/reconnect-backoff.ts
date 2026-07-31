/**
 * Shared reconnect backoff for the long-lived connector transports (Discord,
 * QQ, DingTalk, Slack, Lark, WeCom, Telegram, OneBot, Matrix).
 *
 * Every transport used the identical bare formula
 * `baseMs * min(2 ** attempts, 32)` — capped exponential, but with NO jitter.
 * When one network blip drops N adapters at once they all re-dial in lockstep
 * (a mild thundering herd against the same upstreams). This wraps the shared
 * `computeBackoffDelay` primitive to add proportional jitter while preserving
 * the original `baseMs * 32` ceiling, so the same event no longer produces
 * synchronized retries.
 */

import { computeBackoffDelay } from "@cognia/primitives"

/** Jitter as a fraction of the exponential term (same shape the scheduler uses). */
export const RECONNECT_JITTER_RATIO = 0.25
/** Ceiling multiplier — preserves the historical `baseMs * 32` cap. */
export const RECONNECT_MAX_MULTIPLIER = 32

/**
 * Backoff (ms) before reconnect attempt `attempts` (0-indexed). Result is
 * `min(baseMs * 2**attempts, baseMs * 32)` plus up to `RECONNECT_JITTER_RATIO`
 * of the exponential term. Pass `rng` (defaults to `Math.random`) for
 * deterministic tests.
 */
export function reconnectBackoffMs(baseMs: number, attempts: number, rng?: () => number): number {
  return computeBackoffDelay(attempts, {
    baseDelayMs: baseMs,
    maxDelayMs: baseMs * RECONNECT_MAX_MULTIPLIER,
    jitter: { kind: "ratio", ratio: RECONNECT_JITTER_RATIO, rng },
  })
}
