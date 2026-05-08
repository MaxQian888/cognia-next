import { MAX_ATTEMPTS, backoffDelayMs, decideNextAttempt, isRetryable } from "./retry-policy"

describe("backoffDelayMs", () => {
  it("returns roughly the base delay with no jitter", () => {
    const ms = backoffDelayMs(1, () => 0)
    expect(ms).toBe(1_000)
  })

  it("doubles per attempt", () => {
    expect(backoffDelayMs(2, () => 0)).toBe(2_000)
    expect(backoffDelayMs(3, () => 0)).toBe(4_000)
    expect(backoffDelayMs(4, () => 0)).toBe(8_000)
    expect(backoffDelayMs(5, () => 0)).toBe(16_000)
  })

  it("caps at 60 s for high attempts", () => {
    expect(backoffDelayMs(100, () => 0)).toBe(60_000)
  })

  it("treats attempts <= 0 as 1", () => {
    expect(backoffDelayMs(0, () => 0)).toBe(1_000)
    expect(backoffDelayMs(-5, () => 0)).toBe(1_000)
  })

  it("adds up to 25% jitter", () => {
    const max = backoffDelayMs(1, () => 1)
    expect(max).toBeGreaterThan(1_000)
    expect(max).toBeLessThanOrEqual(1_250)
  })
})

describe("isRetryable", () => {
  it("flags 5xx network/timeout as retryable", () => {
    expect(isRetryable(new Error("503 Service Unavailable"))).toBe(true)
    expect(isRetryable(new Error("Failed to fetch"))).toBe(true)
    expect(isRetryable(new Error("ETIMEDOUT"))).toBe(true)
  })

  it("flags 4xx client errors as non-retryable", () => {
    expect(isRetryable(new Error("401 Unauthorized"))).toBe(false)
    expect(isRetryable(new Error("403 Forbidden"))).toBe(false)
    expect(isRetryable(new Error("404 Not Found"))).toBe(false)
    expect(isRetryable(new Error("400 Bad Request"))).toBe(false)
  })

  it("flags validation errors as non-retryable", () => {
    expect(isRetryable(new Error("schema validation failed"))).toBe(false)
    expect(isRetryable(new Error("validation error: missing field"))).toBe(false)
  })

  it("normalizes non-Error throws", () => {
    expect(isRetryable("401 unauthorized")).toBe(false)
    expect(isRetryable("connection reset")).toBe(true)
  })
})

describe("decideNextAttempt", () => {
  it("schedules retry for retryable errors below max", () => {
    const decision = decideNextAttempt({
      attempts: 0,
      error: new Error("ECONNREFUSED"),
      nowMs: 1_000,
      random: () => 0,
    })
    expect(decision).toEqual({
      status: "pending",
      attempts: 1,
      nextAttemptAt: 2_000, // 1000 + 1000ms backoff
      lastError: "ECONNREFUSED",
    })
  })

  it("deadletters non-retryable errors", () => {
    const decision = decideNextAttempt({
      attempts: 0,
      error: new Error("401 unauthorized"),
      nowMs: 1_000,
      random: () => 0,
    })
    expect(decision.status).toBe("deadlettered")
    expect(decision.attempts).toBe(1)
  })

  it("deadletters when attempts hits MAX_ATTEMPTS", () => {
    const decision = decideNextAttempt({
      attempts: MAX_ATTEMPTS - 1,
      error: new Error("503"),
      nowMs: 0,
      random: () => 0,
    })
    expect(decision.status).toBe("deadlettered")
    expect(decision.attempts).toBe(MAX_ATTEMPTS)
  })

  it("normalizes non-Error errors", () => {
    const decision = decideNextAttempt({
      attempts: 0,
      error: "boom",
      nowMs: 0,
      random: () => 0,
    })
    expect(decision.lastError).toBe("boom")
  })
})
