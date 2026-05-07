import {
  backoffMs,
  formatDeadLetter,
  MAX_BACKOFF_MS,
  MAX_RETRIES,
  parseDeadLetter,
  shouldRetry,
} from "./job-retry"

describe("job-retry: backoffMs", () => {
  // Use a deterministic stub for the random source so tests are stable.
  const noJitter = () => 0

  it("returns the base wait (1s) for attempt #1", () => {
    expect(backoffMs(1, noJitter)).toBe(1_000)
  })

  it("doubles each attempt: 1s, 2s, 4s, 8s", () => {
    expect(backoffMs(1, noJitter)).toBe(1_000)
    expect(backoffMs(2, noJitter)).toBe(2_000)
    expect(backoffMs(3, noJitter)).toBe(4_000)
    expect(backoffMs(4, noJitter)).toBe(8_000)
  })

  it("caps the exponent at MAX_BACKOFF_MS", () => {
    expect(backoffMs(20, noJitter)).toBe(MAX_BACKOFF_MS)
    expect(backoffMs(99, noJitter)).toBe(MAX_BACKOFF_MS)
  })

  it("adds jitter in [0, 500) ms", () => {
    expect(backoffMs(1, () => 0)).toBe(1_000)
    expect(backoffMs(1, () => 0.5)).toBe(1_250)
    // Random 0.999... should still produce <1000+500
    expect(backoffMs(1, () => 0.999)).toBeLessThan(1_500)
  })

  it("falls back to BASE_BACKOFF_MS for invalid attempts", () => {
    expect(backoffMs(0, noJitter)).toBe(1_000)
    expect(backoffMs(-3, noJitter)).toBe(1_000)
    expect(backoffMs(NaN, noJitter)).toBe(1_000)
  })
})

describe("job-retry: shouldRetry", () => {
  it("allows retries while under MAX_RETRIES", () => {
    expect(shouldRetry(0)).toBe(true)
    expect(shouldRetry(MAX_RETRIES - 1)).toBe(true)
  })

  it("denies retries at and above MAX_RETRIES", () => {
    expect(shouldRetry(MAX_RETRIES)).toBe(false)
    expect(shouldRetry(MAX_RETRIES + 5)).toBe(false)
  })

  it("respects a custom max", () => {
    expect(shouldRetry(0, 1)).toBe(true)
    expect(shouldRetry(1, 1)).toBe(false)
  })

  it("rejects negative or NaN counts", () => {
    expect(shouldRetry(-1)).toBe(false)
    expect(shouldRetry(NaN)).toBe(false)
  })
})

describe("job-retry: formatDeadLetter / parseDeadLetter", () => {
  it("round-trips a dead-letter message", () => {
    const formatted = formatDeadLetter("embedding API 500", 4)
    expect(formatted).toBe("dead-letter: embedding API 500 (after 4 attempts)")
    expect(parseDeadLetter(formatted)).toEqual({ message: "embedding API 500", attempts: 4 })
  })

  it("returns null for non-dead-letter messages", () => {
    expect(parseDeadLetter("transient timeout")).toBeNull()
    expect(parseDeadLetter("")).toBeNull()
    expect(parseDeadLetter(undefined)).toBeNull()
  })
})
