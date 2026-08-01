import {
  BASE_BACKOFF_MS,
  DEFAULT_MAX_RETRIES,
  MAX_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  createSideEffectTracker,
  decideRetry,
  isAbortError,
  isRetryableStatus,
  parseRetryAfter,
  resolveRetryPolicy,
  sleepWithAbort,
  type FailureSignal,
  type RetryPolicy,
} from "./retry"

const policy: RetryPolicy = { maxRetries: DEFAULT_MAX_RETRIES, random: () => 1 }

function decide(
  failure: Partial<FailureSignal>,
  overrides: { attempt?: number; sideEffectPerformed?: boolean; policy?: RetryPolicy } = {}
) {
  return decideRetry({
    failure: { code: "provider_error", message: "boom", ...failure },
    attempt: overrides.attempt ?? 0,
    sideEffectPerformed: overrides.sideEffectPerformed ?? false,
    policy: overrides.policy ?? policy,
    now: 1_000_000,
  })
}

describe("resolveRetryPolicy", () => {
  it("defaults to two retries with the standard backoff window", () => {
    const resolved = resolveRetryPolicy()
    expect(resolved.maxRetries).toBe(DEFAULT_MAX_RETRIES)
    expect(resolved.baseBackoffMs).toBe(BASE_BACKOFF_MS)
    expect(resolved.maxBackoffMs).toBe(MAX_BACKOFF_MS)
    expect(typeof resolved.random()).toBe("number")
  })

  it("clamps a negative or fractional retry budget to a whole non-negative count", () => {
    expect(resolveRetryPolicy({ maxRetries: -5 }).maxRetries).toBe(0)
    expect(resolveRetryPolicy({ maxRetries: 2.9 }).maxRetries).toBe(2)
  })
})

describe("decideRetry — the side-effect boundary", () => {
  it("refuses to replay once anything observable has happened", () => {
    expect(decide({}, { sideEffectPerformed: true })).toEqual({
      retry: false,
      reason: "side-effect",
    })
  })

  it("checks the boundary before retryability and before the budget", () => {
    // A perfectly retryable failure with budget left is STILL terminal here.
    expect(
      decide({ code: "provider_error", status: 503 }, { sideEffectPerformed: true, attempt: 0 })
    ).toEqual({ retry: false, reason: "side-effect" })
  })
})

describe("decideRetry — what qualifies", () => {
  it("retries transient provider and transport failures", () => {
    expect(decide({ code: "provider_error" }).retry).toBe(true)
    expect(decide({ code: "transport_error" }).retry).toBe(true)
  })

  it("never retries a fact about the request", () => {
    for (const code of [
      "usage_error",
      "config_error",
      "permission_denied",
      "resource_untrusted",
      "unsupported_capability",
      "tool_error",
    ] as const) {
      expect(decide({ code })).toEqual({ retry: false, reason: "not-retryable" })
    }
  })

  it("retries 429 and the 5xx family but not 4xx or 501", () => {
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
    expect(isRetryableStatus(501)).toBe(false)
    expect(isRetryableStatus(400)).toBe(false)
    expect(isRetryableStatus(401)).toBe(false)
    expect(isRetryableStatus(undefined)).toBe(false)
    expect(decide({ code: "runtime_error", status: 502 }).retry).toBe(true)
    expect(decide({ code: "runtime_error", status: 404 }).retry).toBe(false)
  })

  it("lets an adapter override the code table in both directions", () => {
    expect(decide({ code: "usage_error", retryable: true }).retry).toBe(true)
    expect(decide({ code: "provider_error", retryable: false })).toEqual({
      retry: false,
      reason: "not-retryable",
    })
  })
})

describe("decideRetry — budget and backoff", () => {
  it("stops once the retry budget is spent", () => {
    expect(decide({}, { attempt: 1 }).retry).toBe(true)
    expect(decide({}, { attempt: 2 })).toEqual({ retry: false, reason: "exhausted" })
  })

  it("disables retries entirely at maxRetries 0", () => {
    expect(decide({}, { policy: { maxRetries: 0 } })).toEqual({
      retry: false,
      reason: "exhausted",
    })
  })

  it("grows the backoff window exponentially and caps it", () => {
    const first = decide({}, { attempt: 0 })
    const second = decide({}, { attempt: 1 })
    expect(first).toEqual({ retry: true, delayMs: BASE_BACKOFF_MS })
    expect(second).toEqual({ retry: true, delayMs: BASE_BACKOFF_MS * 2 })

    const capped = decide({}, { attempt: 20, policy: { maxRetries: 50, random: () => 1 } })
    expect(capped).toEqual({ retry: true, delayMs: MAX_BACKOFF_MS })
  })

  it("applies full jitter, so a zero draw waits no time at all", () => {
    expect(decide({}, { policy: { maxRetries: 2, random: () => 0 } })).toEqual({
      retry: true,
      delayMs: 0,
    })
  })
})

describe("Retry-After handling", () => {
  it("parses delta-seconds, numbers and HTTP-dates", () => {
    expect(parseRetryAfter("2")).toBe(2000)
    expect(parseRetryAfter("1.5")).toBe(1500)
    expect(parseRetryAfter(3)).toBe(3000)
    const now = Date.parse("2026-01-01T00:00:00.000Z")
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000)
  })

  it("returns null rather than guessing at absent or unparsable values", () => {
    expect(parseRetryAfter(undefined)).toBeNull()
    expect(parseRetryAfter("")).toBeNull()
    expect(parseRetryAfter("soon")).toBeNull()
    expect(parseRetryAfter(-1)).toBeNull()
    expect(parseRetryAfter(Number.NaN)).toBeNull()
  })

  it("treats a Retry-After in the past as retry-now, not as negative time", () => {
    const now = Date.parse("2026-01-01T00:00:10.000Z")
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0)
  })

  it("honours Retry-After in place of the computed backoff", () => {
    const decision = decide({ retryAfter: 4 })
    expect(decision).toEqual({ retry: true, delayMs: 4000, retryAfterMs: 4000 })
  })

  it("refuses a Retry-After longer than a headless turn can wait", () => {
    expect(decide({ retryAfter: MAX_RETRY_AFTER_MS / 1000 + 1 })).toEqual({
      retry: false,
      reason: "not-retryable",
    })
    expect(decide({ retryAfter: MAX_RETRY_AFTER_MS / 1000 }).retry).toBe(true)
  })
})

describe("createSideEffectTracker", () => {
  it("starts clean and latches on the first mark", () => {
    const tracker = createSideEffectTracker()
    expect(tracker.performed).toBe(false)
    expect(tracker.reason).toBeNull()

    tracker.mark("tool-call:Bash")
    expect(tracker.performed).toBe(true)
    expect(tracker.reason).toBe("tool-call:Bash")
  })

  it("keeps the FIRST reason — later marks never overwrite it", () => {
    const tracker = createSideEffectTracker()
    tracker.mark("text-delta")
    tracker.mark("tool-call:Write")
    expect(tracker.reason).toBe("text-delta")
  })
})

describe("sleepWithAbort", () => {
  it("resolves after the delay", async () => {
    const started = Date.now()
    await sleepWithAbort(20)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })

  it("resolves immediately for a non-positive delay", async () => {
    await expect(sleepWithAbort(0)).resolves.toBeUndefined()
    await expect(sleepWithAbort(-5)).resolves.toBeUndefined()
  })

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort("already gone")
    await expect(sleepWithAbort(1000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "already gone",
    })
  })

  it("rejects mid-wait when the signal aborts, without waiting out the timer", async () => {
    const controller = new AbortController()
    const pending = sleepWithAbort(10_000, controller.signal)
    setTimeout(() => controller.abort(), 5)
    const started = Date.now()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it("falls back to a generic message when the abort reason is not a string", async () => {
    const controller = new AbortController()
    controller.abort(new Error("object reason"))
    await expect(sleepWithAbort(10, controller.signal)).rejects.toMatchObject({
      message: "the turn was cancelled",
    })
  })
})

describe("isAbortError", () => {
  it("recognises an abort and nothing else", () => {
    const abort = new Error("x")
    abort.name = "AbortError"
    expect(isAbortError(abort)).toBe(true)
    expect(isAbortError(new Error("x"))).toBe(false)
    expect(isAbortError("AbortError")).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})
