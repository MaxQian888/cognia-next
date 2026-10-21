/**
 * The plugin contract's share of `lib/connectors/rate-limit.ts`, which re-exports these.
 */
/**
 * Inspectable snapshot of the bucket — used by the heartbeat probe so the
 * Health Detail panel can render available/capacity/refill metadata.
 */
export interface TokenBucketSnapshot {
  /** Tokens currently available (fractional). */
  available: number
  /** Maximum tokens the bucket can hold. */
  capacity: number
  /** Refill rate, tokens per second. */
  refillPerSec: number
  /**
   * Wall-clock ms at which the bucket will next have at least one whole
   * token available. Equal to `now` when there is already ≥1 token; equal
   * to `null` when `refillPerSec === 0` (no future refill scheduled).
   */
  nextRefillAt: number | null
}
