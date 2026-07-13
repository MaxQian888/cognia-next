import {
  reconnectBackoffMs,
  RECONNECT_JITTER_RATIO,
  RECONNECT_MAX_MULTIPLIER,
} from "./reconnect-backoff"

describe("reconnectBackoffMs", () => {
  it("with zero rng reproduces the historical capped-exponential value", () => {
    const base = 1000
    const zero = () => 0
    expect(reconnectBackoffMs(base, 0, zero)).toBe(1000)
    expect(reconnectBackoffMs(base, 1, zero)).toBe(2000)
    expect(reconnectBackoffMs(base, 3, zero)).toBe(8000)
    // Cap: 2**6 = 64 > 32 → clamped to base * 32.
    expect(reconnectBackoffMs(base, 6, zero)).toBe(base * RECONNECT_MAX_MULTIPLIER)
    expect(reconnectBackoffMs(base, 10, zero)).toBe(base * RECONNECT_MAX_MULTIPLIER)
  })

  it("adds up to RECONNECT_JITTER_RATIO of the exponential term", () => {
    const base = 1000
    // rng()=1 → maximum jitter = ratio * exponential added on top.
    const full = reconnectBackoffMs(base, 2, () => 1) // exp = 4000
    expect(full).toBeCloseTo(4000 + 4000 * RECONNECT_JITTER_RATIO, 5)
  })

  it("keeps jitter within [0, ratio*exp] for a mid-range rng", () => {
    const base = 1000
    const exp = base * 2 ** 2 // 4000
    const v = reconnectBackoffMs(base, 2, () => 0.5)
    expect(v).toBeGreaterThanOrEqual(exp)
    expect(v).toBeLessThanOrEqual(exp + exp * RECONNECT_JITTER_RATIO)
  })
})
