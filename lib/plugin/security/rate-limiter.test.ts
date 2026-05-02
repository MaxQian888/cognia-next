/**
 * Tests for PluginRateLimiter
 */

import {
  PluginRateLimiter,
  RateLimitError,
  DEFAULT_RATE_LIMITS,
  resetPluginRateLimiter,
} from "./rate-limiter"

describe("PluginRateLimiter", () => {
  afterEach(() => {
    resetPluginRateLimiter()
  })

  it("allows requests within capacity", () => {
    const limiter = new PluginRateLimiter({
      test: { capacity: 2, refillPerSecond: 0 },
    })

    expect(() => limiter.check("plugin-a", "test")).not.toThrow()
    expect(() => limiter.check("plugin-a", "test")).not.toThrow()
  })

  it("throws when exceeding capacity", () => {
    const limiter = new PluginRateLimiter({
      test: { capacity: 1, refillPerSecond: 0 },
    })

    limiter.check("plugin-a", "test")
    expect(() => limiter.check("plugin-a", "test")).toThrow(RateLimitError)
  })

  it("refills tokens over time", () => {
    const limiter = new PluginRateLimiter({
      test: { capacity: 1, refillPerSecond: 1 },
    })

    const now = Date.now()
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now + 1000)

    limiter.check("plugin-a", "test")

    expect(() => limiter.check("plugin-a", "test")).toThrow(RateLimitError)

    expect(() => limiter.check("plugin-a", "test")).not.toThrow()

    nowSpy.mockRestore()
  })

  it("ignores operations without limits", () => {
    const limiter = new PluginRateLimiter(DEFAULT_RATE_LIMITS)

    expect(() => limiter.check("plugin-a", "unknown")).not.toThrow()
  })

  it("resets plugin buckets", () => {
    const limiter = new PluginRateLimiter({
      test: { capacity: 1, refillPerSecond: 0 },
    })

    limiter.check("plugin-a", "test")
    expect(() => limiter.check("plugin-a", "test")).toThrow(RateLimitError)

    limiter.reset("plugin-a")
    expect(() => limiter.check("plugin-a", "test")).not.toThrow()
  })
})
