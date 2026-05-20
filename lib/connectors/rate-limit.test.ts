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

describe("createTokenBucket — snapshot()", () => {
  it("reports full capacity on a fresh bucket", () => {
    const t = 0
    const bucket = createTokenBucket({ capacity: 10, refillPerSec: 5, now: () => t })
    const snap = bucket.snapshot()
    expect(snap.available).toBe(10)
    expect(snap.capacity).toBe(10)
    expect(snap.refillPerSec).toBe(5)
    expect(snap.nextRefillAt).toBe(0)
  })

  it("does NOT consume tokens", () => {
    const bucket = createTokenBucket({ capacity: 3, refillPerSec: 0 })
    bucket.snapshot()
    bucket.snapshot()
    bucket.snapshot()
    expect(bucket.tryAcquire(3)).toBe(true)
  })

  it("reflects drained state and computes nextRefillAt for the next whole token", () => {
    const t = 0
    const bucket = createTokenBucket({ capacity: 2, refillPerSec: 2, now: () => t })
    bucket.tryAcquire(2)
    const snap = bucket.snapshot()
    expect(snap.available).toBeCloseTo(0, 6)
    // refillPerSec=2 → 1 token in 500 ms
    expect(snap.nextRefillAt).toBe(500)
  })

  it("reports nextRefillAt = now when at least one token is already available", () => {
    const t = 100
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 1, now: () => t })
    bucket.tryAcquire(3)
    const snap = bucket.snapshot()
    expect(snap.available).toBeGreaterThanOrEqual(1)
    expect(snap.nextRefillAt).toBe(100)
  })

  it("returns nextRefillAt = null when refillPerSec is zero", () => {
    const bucket = createTokenBucket({ capacity: 1, refillPerSec: 0 })
    bucket.tryAcquire(1)
    const snap = bucket.snapshot()
    expect(snap.refillPerSec).toBe(0)
    expect(snap.nextRefillAt).toBeNull()
  })
})
