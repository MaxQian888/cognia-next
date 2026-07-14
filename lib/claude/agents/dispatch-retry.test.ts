import {
  retryDelayMs,
  shouldRetryDispatch,
  waitForRetry,
  type DispatchRetryPolicy,
} from "./dispatch-retry"
import type { PluginDispatchErrorEnvelope } from "@/types/plugin/plugin-agent-sdk"

const policy: DispatchRetryPolicy = { maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 8_000 }

function envelope(over: Partial<PluginDispatchErrorEnvelope> = {}): PluginDispatchErrorEnvelope {
  return { code: "rate-limit", retryable: true, message: "429", ...over }
}

function ctx(over: Partial<Parameters<typeof shouldRetryDispatch>[1]> = {}) {
  return {
    attempt: 1,
    policy,
    signal: new AbortController().signal,
    nextDelayMs: 1_000,
    budgetExhausted: () => false,
    ...over,
  }
}

describe("retryDelayMs", () => {
  const noJitter = () => 0

  it("grows exponentially from baseDelayMs", () => {
    expect(retryDelayMs(policy, 1, undefined, noJitter)).toBe(1_000)
    expect(retryDelayMs(policy, 2, undefined, noJitter)).toBe(2_000)
    expect(retryDelayMs(policy, 3, undefined, noJitter)).toBe(4_000)
  })

  it("caps at maxDelayMs", () => {
    expect(retryDelayMs(policy, 10, undefined, noJitter)).toBe(8_000)
  })

  it("prefers the provider Retry-After hint (still capped)", () => {
    expect(retryDelayMs(policy, 1, 5_000, noJitter)).toBe(5_000)
    expect(retryDelayMs(policy, 1, 60_000, noJitter)).toBe(8_000)
  })

  it("adds at most 10% jitter", () => {
    expect(retryDelayMs(policy, 1, undefined, () => 1)).toBe(1_100)
  })
})

describe("shouldRetryDispatch", () => {
  it("retries a transient envelope within the allowance", () => {
    expect(shouldRetryDispatch(envelope(), ctx())).toBe(true)
  })

  it("never retries non-retryable envelopes", () => {
    for (const code of ["auth", "aborted", "rejection-cycle", "budget-exhausted"] as const) {
      expect(shouldRetryDispatch(envelope({ code, retryable: false }), ctx())).toBe(false)
    }
  })

  it("stops when the retry allowance is spent", () => {
    expect(shouldRetryDispatch(envelope(), ctx({ attempt: 2 }))).toBe(true)
    expect(shouldRetryDispatch(envelope(), ctx({ attempt: 3 }))).toBe(false)
  })

  it("honors maxRetries=0 (retries disabled)", () => {
    expect(shouldRetryDispatch(envelope(), ctx({ policy: { ...policy, maxRetries: 0 } }))).toBe(
      false
    )
  })

  it("stops after the caller aborted", () => {
    const controller = new AbortController()
    controller.abort()
    expect(shouldRetryDispatch(envelope(), ctx({ signal: controller.signal }))).toBe(false)
  })

  it("stops when the backoff cannot fit inside the subtree deadline", () => {
    const now = () => 10_000
    expect(
      shouldRetryDispatch(envelope(), ctx({ deadlineMs: 10_500, nextDelayMs: 1_000, now }))
    ).toBe(false)
    expect(
      shouldRetryDispatch(envelope(), ctx({ deadlineMs: 12_000, nextDelayMs: 1_000, now }))
    ).toBe(true)
  })

  it("re-checks the token budget before every retry", () => {
    expect(shouldRetryDispatch(envelope(), ctx({ budgetExhausted: () => true }))).toBe(false)
  })
})

describe("waitForRetry", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("resolves after the delay", async () => {
    const controller = new AbortController()
    const done = jest.fn()
    void waitForRetry(1_000, controller.signal).then(done)

    await jest.advanceTimersByTimeAsync(999)
    expect(done).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(done).toHaveBeenCalled()
  })

  it("resolves early when the signal aborts mid-backoff", async () => {
    const controller = new AbortController()
    const done = jest.fn()
    void waitForRetry(60_000, controller.signal).then(done)

    await jest.advanceTimersByTimeAsync(10)
    controller.abort()
    await Promise.resolve()
    expect(done).toHaveBeenCalled()
  })

  it("resolves immediately for an already-aborted signal or zero delay", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(waitForRetry(5_000, controller.signal)).resolves.toBeUndefined()
    await expect(waitForRetry(0, new AbortController().signal)).resolves.toBeUndefined()
  })
})
