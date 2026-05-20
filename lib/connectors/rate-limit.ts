/**
 * Token-bucket rate limiter — Task 38.
 *
 * The bucket starts full (capacity tokens). Tokens refill continuously at
 * `refillPerSec` tokens per second, capped at `capacity`. Each `tryAcquire(n)`
 * call checks if at least n tokens are available; if so, consumes them and
 * returns true. Otherwise returns false without consuming anything.
 */

export interface TokenBucketOptions {
  /** Maximum number of tokens the bucket can hold. */
  capacity: number
  /** Tokens added per second (fractional values allowed). */
  refillPerSec: number
  /** Clock injection for tests. Defaults to `() => Date.now()`. */
  now?: () => number
}

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

export interface TokenBucket {
  /**
   * Attempt to acquire `n` tokens (default 1).
   * Returns true and deducts n tokens if available; false otherwise.
   */
  tryAcquire(n?: number): boolean
  /**
   * Inspectable snapshot of the bucket. Pure read — does NOT consume any
   * tokens. Internally refills the bucket so the snapshot reflects the
   * live state at call time.
   */
  snapshot(): TokenBucketSnapshot
}

export function createTokenBucket(opts: TokenBucketOptions): TokenBucket {
  const { capacity, refillPerSec } = opts
  const clock = opts.now ?? (() => Date.now())

  let tokens = capacity
  let lastRefillAt = clock()

  function refill(now: number): void {
    const elapsed = (now - lastRefillAt) / 1000 // seconds
    if (elapsed <= 0) return
    tokens = Math.min(capacity, tokens + elapsed * refillPerSec)
    lastRefillAt = now
  }

  return {
    tryAcquire(n = 1): boolean {
      const now = clock()
      refill(now)
      if (tokens >= n) {
        tokens -= n
        return true
      }
      return false
    },

    snapshot(): TokenBucketSnapshot {
      const now = clock()
      refill(now)
      let nextRefillAt: number | null
      if (refillPerSec <= 0) {
        nextRefillAt = null
      } else if (tokens >= 1) {
        nextRefillAt = now
      } else {
        const tokensNeeded = 1 - tokens
        const msUntilOne = (tokensNeeded / refillPerSec) * 1000
        nextRefillAt = now + msUntilOne
      }
      return { available: tokens, capacity, refillPerSec, nextRefillAt }
    },
  }
}
