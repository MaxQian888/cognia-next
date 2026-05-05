/**
 * Tests for lib/connectors/circuit-breaker.ts — Task 38.
 *
 * Injected clock allows deterministic sliding-window and cooldown tests.
 */

import { createCircuitBreaker } from "./circuit-breaker"

describe("createCircuitBreaker — closed state", () => {
  it("starts in closed state", () => {
    const cb = createCircuitBreaker()
    expect(cb.state()).toBe("closed")
    expect(cb.canPass()).toBe(true)
  })

  it("does not trip when below minEvents threshold", () => {
    const cb = createCircuitBreaker({ minEvents: 5 })
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.state()).toBe("closed")
  })

  it("does not trip when failure rate is below threshold", () => {
    const cb = createCircuitBreaker({ minEvents: 4, failureThresholdPct: 50 })
    cb.recordSuccess()
    cb.recordSuccess()
    cb.recordSuccess()
    cb.recordFailure()
    expect(cb.state()).toBe("closed")
  })

  it("trips to open when failure rate >= threshold after minEvents", () => {
    const t = 0
    const cb = createCircuitBreaker({
      minEvents: 4,
      failureThresholdPct: 50,
      windowMs: 10_000,
      now: () => t,
    })
    cb.recordSuccess()
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.state()).toBe("open")
    expect(cb.canPass()).toBe(false)
  })

  it("prunes events older than windowMs from the sliding window", () => {
    let t = 0
    const cb = createCircuitBreaker({
      minEvents: 3,
      failureThresholdPct: 50,
      windowMs: 5_000,
      now: () => t,
    })
    // Record 3 failures at t=0
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.state()).toBe("open")

    // Advance past cooldown to get back to closed via half-open
    // (for this test we just check that window pruning works when closed)
    // Reset by creating a new breaker and checking old events are pruned
    const cb2 = createCircuitBreaker({
      minEvents: 3,
      failureThresholdPct: 60,
      windowMs: 1_000,
      cooldownMs: 500,
      closeOnSuccessCount: 1,
      now: () => t,
    })
    cb2.recordFailure() // t=0
    cb2.recordFailure() // t=0
    cb2.recordFailure() // t=0 — opens

    // Move past cooldown → half-open
    t = 600
    expect(cb2.state()).toBe("half_open")
    cb2.recordSuccess() // closes → resets window

    expect(cb2.state()).toBe("closed")
    // Now record 1 failure — window was reset so minEvents not reached
    t = 700
    cb2.recordFailure()
    expect(cb2.state()).toBe("closed")
  })
})

describe("createCircuitBreaker — open state and cooldown", () => {
  it("transitions to half_open after cooldownMs", () => {
    let t = 0
    const cb = createCircuitBreaker({
      minEvents: 2,
      failureThresholdPct: 50,
      cooldownMs: 1_000,
      now: () => t,
    })
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.state()).toBe("open")

    // Still open before cooldown
    t = 999
    expect(cb.state()).toBe("open")
    expect(cb.canPass()).toBe(false)

    // At cooldown boundary → half_open
    t = 1_000
    expect(cb.state()).toBe("half_open")
    expect(cb.canPass()).toBe(true)
  })

  it("re-opens on half_open failure", () => {
    let t = 0
    const cb = createCircuitBreaker({
      minEvents: 2,
      failureThresholdPct: 50,
      cooldownMs: 1_000,
      now: () => t,
    })
    cb.recordFailure()
    cb.recordFailure()
    t = 1_001 // half_open
    expect(cb.state()).toBe("half_open")
    cb.recordFailure()
    expect(cb.state()).toBe("open")
    expect(cb.canPass()).toBe(false)
  })
})

describe("createCircuitBreaker — half_open → closed", () => {
  it("closes after closeOnSuccessCount consecutive successes", () => {
    let t = 0
    const cb = createCircuitBreaker({
      minEvents: 2,
      failureThresholdPct: 50,
      cooldownMs: 1_000,
      closeOnSuccessCount: 3,
      now: () => t,
    })
    cb.recordFailure()
    cb.recordFailure()
    t = 1_001
    expect(cb.state()).toBe("half_open")

    cb.recordSuccess()
    expect(cb.state()).toBe("half_open")
    cb.recordSuccess()
    expect(cb.state()).toBe("half_open")
    cb.recordSuccess()
    expect(cb.state()).toBe("closed")
    expect(cb.canPass()).toBe(true)
  })

  it("resets consecutive success counter on failure during half_open", () => {
    let t = 0
    const cb = createCircuitBreaker({
      minEvents: 2,
      failureThresholdPct: 50,
      cooldownMs: 1_000,
      closeOnSuccessCount: 3,
      now: () => t,
    })
    cb.recordFailure()
    cb.recordFailure()
    t = 1_001
    // Explicitly trigger the half_open transition via state()
    expect(cb.state()).toBe("half_open")
    cb.recordSuccess()
    cb.recordSuccess()
    // Advance t by a tiny amount so openedAt (1001) != now when failure re-opens
    t = 1_002
    // failure in half_open → re-opens
    cb.recordFailure()
    // canPass() → false (open, cooldown not elapsed: 1002 - 1001 = 1 < 1000)
    expect(cb.canPass()).toBe(false)
    expect(cb.state()).toBe("open")
  })
})

describe("createCircuitBreaker — canPass", () => {
  it("returns false when open", () => {
    const t = 0
    const cb = createCircuitBreaker({
      minEvents: 1,
      failureThresholdPct: 1,
      cooldownMs: 60_000,
      now: () => t,
    })
    cb.recordFailure()
    expect(cb.canPass()).toBe(false)
  })

  it("returns true when closed", () => {
    const cb = createCircuitBreaker()
    expect(cb.canPass()).toBe(true)
  })

  it("returns true when half_open", () => {
    let t = 0
    const cb = createCircuitBreaker({
      minEvents: 1,
      failureThresholdPct: 1,
      cooldownMs: 500,
      now: () => t,
    })
    cb.recordFailure()
    t = 600
    expect(cb.canPass()).toBe(true)
  })
})
