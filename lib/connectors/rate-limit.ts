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

export interface TokenBucket {
  /**
   * Attempt to acquire `n` tokens (default 1).
   * Returns true and deducts n tokens if available; false otherwise.
   */
  tryAcquire(n?: number): boolean
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
  }
}
