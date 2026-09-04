import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  backoffDelayMs,
  isCheckDue,
  nextCheckAt,
  parseRetryAfter,
} from "./backoff"

const noJitter = () => 0

describe("backoffDelayMs", () => {
  it("uses the plain interval when nothing has failed", () => {
    expect(backoffDelayMs({ consecutiveFailures: 0, intervalMs: 60_000, random: noJitter })).toBe(
      60_000
    )
  })

  it("doubles with each consecutive failure", () => {
    const at = (n: number) =>
      backoffDelayMs({ consecutiveFailures: n, intervalMs: 1000, random: noJitter })
    expect(at(1)).toBe(BASE_BACKOFF_MS)
    expect(at(2)).toBe(BASE_BACKOFF_MS * 2)
    expect(at(3)).toBe(BASE_BACKOFF_MS * 4)
  })

  it("stops doubling at the ceiling", () => {
    expect(backoffDelayMs({ consecutiveFailures: 40, intervalMs: 1000, random: noJitter })).toBe(
      MAX_BACKOFF_MS
    )
  })

  it("adds jitter above the base delay, never below it", () => {
    const base = backoffDelayMs({ consecutiveFailures: 1, intervalMs: 1000, random: noJitter })
    const jittered = backoffDelayMs({ consecutiveFailures: 1, intervalMs: 1000, random: () => 1 })
    expect(jittered).toBeGreaterThan(base)
    expect(jittered).toBeLessThanOrEqual(base * 1.2)
  })

  it("honors a Retry-After longer than its own ramp", () => {
    const delay = backoffDelayMs({
      consecutiveFailures: 1,
      intervalMs: 1000,
      retryAfterMs: 10 * BASE_BACKOFF_MS,
      random: noJitter,
    })
    expect(delay).toBe(10 * BASE_BACKOFF_MS)
  })

  it("ignores a Retry-After shorter than its own ramp", () => {
    const delay = backoffDelayMs({
      consecutiveFailures: 4,
      intervalMs: 1000,
      retryAfterMs: 1,
      random: noJitter,
    })
    expect(delay).toBe(BASE_BACKOFF_MS * 8)
  })
})

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-01-01T00:00:00Z")

  it("reads delta seconds", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000)
  })

  it("reads an HTTP date", () => {
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:02:00 GMT", now)).toBe(120_000)
  })

  it("clamps a date already in the past to zero", () => {
    expect(parseRetryAfter("Thu, 01 Jan 2020 00:00:00 GMT", now)).toBe(0)
  })

  it("clamps a hostile value", () => {
    expect(parseRetryAfter(String(60 * 60 * 24 * 365), now)).toBe(MAX_RETRY_AFTER_MS)
  })

  it("returns undefined rather than guessing at garbage", () => {
    expect(parseRetryAfter("soon", now)).toBeUndefined()
    expect(parseRetryAfter("", now)).toBeUndefined()
    expect(parseRetryAfter(null, now)).toBeUndefined()
  })
})

describe("scheduling", () => {
  it("computes the next allowed check from now", () => {
    expect(nextCheckAt(1000, { consecutiveFailures: 0, intervalMs: 500, random: noJitter })).toBe(
      1500
    )
  })

  it("treats an unscheduled asset as due", () => {
    expect(isCheckDue(0, undefined)).toBe(true)
  })

  it("holds an asset until its window opens", () => {
    expect(isCheckDue(999, 1000)).toBe(false)
    expect(isCheckDue(1000, 1000)).toBe(true)
  })
})
