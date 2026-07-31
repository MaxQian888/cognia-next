// Pure table tests for the speak rate limiter — injected clock, no wall time.

import { createSpeakLimiter, getSpeakLimiter, __resetSpeakLimiterForTesting } from "./speak-limiter"

const T0 = 1_000_000

describe("createSpeakLimiter", () => {
  it("accepts the first call and rejects within the min interval", () => {
    const limiter = createSpeakLimiter({ minIntervalMs: 3000, maxPerMinute: 8 })
    expect(limiter.tryAcquire(T0)).toBe(true)
    expect(limiter.tryAcquire(T0 + 2999)).toBe(false)
    expect(limiter.tryAcquire(T0 + 3000)).toBe(true)
  })

  it("rejected calls do not reset the interval", () => {
    const limiter = createSpeakLimiter({ minIntervalMs: 3000, maxPerMinute: 8 })
    limiter.tryAcquire(T0)
    limiter.tryAcquire(T0 + 1000) // rejected
    // 3s after the ACCEPTED call, not the rejected one.
    expect(limiter.tryAcquire(T0 + 3000)).toBe(true)
  })

  it("caps accepted calls inside the trailing minute", () => {
    const limiter = createSpeakLimiter({ minIntervalMs: 0, maxPerMinute: 3 })
    expect(limiter.tryAcquire(T0)).toBe(true)
    expect(limiter.tryAcquire(T0 + 1)).toBe(true)
    expect(limiter.tryAcquire(T0 + 2)).toBe(true)
    expect(limiter.tryAcquire(T0 + 3)).toBe(false)
    // A minute later the window has drained.
    expect(limiter.tryAcquire(T0 + 60_001)).toBe(true)
  })

  it("recovers gradually as old entries age out", () => {
    const limiter = createSpeakLimiter({ minIntervalMs: 0, maxPerMinute: 2 })
    limiter.tryAcquire(T0)
    limiter.tryAcquire(T0 + 30_000)
    expect(limiter.tryAcquire(T0 + 40_000)).toBe(false)
    // First entry ages out at T0+60s.
    expect(limiter.tryAcquire(T0 + 60_001)).toBe(true)
  })
})

describe("getSpeakLimiter", () => {
  beforeEach(() => __resetSpeakLimiterForTesting())

  it("returns a shared singleton until reset", () => {
    const a = getSpeakLimiter()
    expect(getSpeakLimiter()).toBe(a)
    __resetSpeakLimiterForTesting()
    expect(getSpeakLimiter()).not.toBe(a)
  })
})
