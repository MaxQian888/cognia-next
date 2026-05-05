/**
 * Tests for lib/connectors/rate-limit.ts — Task 38.
 *
 * Injected clock allows deterministic refill rate and capacity cap tests.
 */

import { createTokenBucket } from "./rate-limit"

describe("createTokenBucket", () => {
  it("starts full (capacity tokens available)", () => {
    const bucket = createTokenBucket({ capacity: 10, refillPerSec: 1 })
    // Should be able to acquire up to capacity tokens immediately
    for (let i = 0; i < 10; i++) {
      expect(bucket.tryAcquire()).toBe(true)
    }
    expect(bucket.tryAcquire()).toBe(false)
  })

  it("tryAcquire(1) deducts one token", () => {
    const bucket = createTokenBucket({ capacity: 3, refillPerSec: 0 })
    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.tryAcquire()).toBe(false)
  })

  it("tryAcquire(n) deducts n tokens atomically", () => {
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 0 })
    expect(bucket.tryAcquire(3)).toBe(true)
    // 2 tokens remaining; acquiring 3 should fail without consuming
    expect(bucket.tryAcquire(3)).toBe(false)
    expect(bucket.tryAcquire(2)).toBe(true)
    expect(bucket.tryAcquire(1)).toBe(false)
  })

  it("refills at the specified rate", () => {
    let t = 0
    const bucket = createTokenBucket({ capacity: 10, refillPerSec: 2, now: () => t })
    // Drain all 10
    for (let i = 0; i < 10; i++) bucket.tryAcquire()
    expect(bucket.tryAcquire()).toBe(false)

    // Advance 1 second → 2 tokens refilled
    t = 1_000
    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.tryAcquire()).toBe(false)
  })

  it("does not exceed capacity on refill", () => {
    let t = 0
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 10, now: () => t })
    // Start full — advance 10 seconds (would add 100 tokens without cap)
    t = 10_000
    // Should only allow 5 (capacity)
    let count = 0
    while (bucket.tryAcquire()) count++
    expect(count).toBe(5)
  })

  it("handles fractional refill rates", () => {
    let t = 0
    // 0.5 tokens/sec → 1 token every 2 seconds
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 0.5, now: () => t })
    // Drain all 5
    for (let i = 0; i < 5; i++) bucket.tryAcquire()
    expect(bucket.tryAcquire()).toBe(false)

    // 1 second → 0.5 tokens, not enough for 1
    t = 1_000
    expect(bucket.tryAcquire()).toBe(false)

    // 2 seconds → 1 token
    t = 2_000
    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.tryAcquire()).toBe(false)
  })

  it("tryAcquire fails without consuming when n > available", () => {
    const bucket = createTokenBucket({ capacity: 2, refillPerSec: 0 })
    // 2 tokens available; requesting 3 must fail without consuming
    expect(bucket.tryAcquire(3)).toBe(false)
    // Still 2 tokens available
    expect(bucket.tryAcquire(2)).toBe(true)
  })
})
