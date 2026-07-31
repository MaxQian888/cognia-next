import type { CircuitBreaker, CircuitBreakerSnapshot } from "@/lib/connectors/circuit-breaker"
import { CircuitOpenError, runResilient } from "@/lib/plugin/resilience/run-resilient"
import { TimeoutError } from "@cognia/primitives"

interface FakeBreaker extends CircuitBreaker {
  recordSuccess: jest.Mock
  recordFailure: jest.Mock
  canPass: jest.Mock
}

function fakeBreaker(canPass = true): FakeBreaker {
  return {
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
    canPass: jest.fn(() => canPass),
    state: jest.fn(() => (canPass ? "closed" : "open")),
    snapshot: jest.fn((): CircuitBreakerSnapshot => ({
      state: canPass ? "closed" : "open",
      openedAt: null,
      halfOpenSuccesses: 0,
      recentFailureRate: 0,
      eventCount: 0,
    })),
  }
}

const baseOpts = (breaker: FakeBreaker) => ({
  timeoutMs: 1000,
  maxRetries: 2,
  retryable: true,
  breaker,
  label: "p/tool",
  random: () => 0, // deterministic backoff
  sleep: jest.fn(async () => undefined),
})

describe("runResilient", () => {
  it("returns the value on first success and records success", async () => {
    const breaker = fakeBreaker()
    const fn = jest.fn(async () => "ok")
    await expect(runResilient(fn, baseOpts(breaker))).resolves.toBe("ok")
    expect(fn).toHaveBeenCalledTimes(1)
    expect(breaker.recordSuccess).toHaveBeenCalledTimes(1)
    expect(breaker.recordFailure).not.toHaveBeenCalled()
  })

  it("throws CircuitOpenError without running fn when the breaker is open", async () => {
    const breaker = fakeBreaker(false)
    const fn = jest.fn(async () => "ok")
    await expect(runResilient(fn, baseOpts(breaker))).rejects.toBeInstanceOf(CircuitOpenError)
    expect(fn).not.toHaveBeenCalled()
  })

  it("retries a transient failure then succeeds, sleeping with backoff", async () => {
    const breaker = fakeBreaker()
    const opts = baseOpts(breaker)
    const fn = jest
      .fn<Promise<string>, [AbortSignal]>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce("recovered")
    await expect(runResilient(fn, opts)).resolves.toBe("recovered")
    expect(fn).toHaveBeenCalledTimes(2)
    expect(breaker.recordFailure).toHaveBeenCalledTimes(1)
    expect(breaker.recordSuccess).toHaveBeenCalledTimes(1)
    // backoffDelayMs(1, () => 0) === 1000
    expect(opts.sleep).toHaveBeenCalledWith(1000, undefined)
  })

  it("does not retry a fatal error", async () => {
    const breaker = fakeBreaker()
    const opts = baseOpts(breaker)
    const fn = jest.fn(async () => Promise.reject(new Error("schema validation failed")))
    await expect(runResilient(fn, opts)).rejects.toThrow(/validation/)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(breaker.recordFailure).toHaveBeenCalledTimes(1)
    expect(opts.sleep).not.toHaveBeenCalled()
  })

  it("does not retry when retryable is false, even on a transient error", async () => {
    const breaker = fakeBreaker()
    const opts = { ...baseOpts(breaker), retryable: false }
    const fn = jest.fn(async () => Promise.reject(new Error("ECONNRESET")))
    await expect(runResilient(fn, opts)).rejects.toThrow(/ECONNRESET/)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(breaker.recordFailure).toHaveBeenCalledTimes(1)
  })

  it("times out a hung call and records it as a failure", async () => {
    const breaker = fakeBreaker()
    const opts = { ...baseOpts(breaker), retryable: false, timeoutMs: 10 }
    // Ignores its signal and never settles → withTimeout must fire.
    const fn = jest.fn(() => new Promise<string>(() => {}))
    await expect(runResilient(fn, opts)).rejects.toBeInstanceOf(TimeoutError)
    expect(breaker.recordFailure).toHaveBeenCalledTimes(1)
  })

  it("treats an error as fatal when the isRetryable override returns false", async () => {
    const breaker = fakeBreaker()
    const opts = { ...baseOpts(breaker), isRetryable: () => false }
    // A normally-transient error, forced fatal by the override → no retry.
    const fn = jest.fn(async () => Promise.reject(new Error("ECONNRESET")))
    await expect(runResilient(fn, opts)).rejects.toThrow(/ECONNRESET/)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(opts.sleep).not.toHaveBeenCalled()
  })

  it("throws immediately when the caller signal is already aborted", async () => {
    const breaker = fakeBreaker()
    const controller = new AbortController()
    controller.abort()
    const fn = jest.fn(async () => "ok")
    await expect(
      runResilient(fn, { ...baseOpts(breaker), signal: controller.signal })
    ).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(fn).not.toHaveBeenCalled()
    expect(breaker.recordFailure).not.toHaveBeenCalled()
  })

  it("uses the real backoff sleep when none is injected (retry then succeed)", async () => {
    const breaker = fakeBreaker()
    const fn = jest
      .fn<Promise<string>, [AbortSignal]>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce("ok")
    // No `sleep` override → defaultSleep runs. random()=>0 keeps backoff at ~1s.
    const opts = { ...baseOpts(breaker), sleep: undefined as never }
    await expect(runResilient(fn, opts)).resolves.toBe("ok")
    expect(fn).toHaveBeenCalledTimes(2)
  }, 10_000)

  it("aborts the backoff sleep when the caller signal fires mid-wait", async () => {
    const breaker = fakeBreaker()
    const controller = new AbortController()
    const fn = jest.fn(async () => Promise.reject(new Error("ECONNRESET")))
    const opts = { ...baseOpts(breaker), sleep: undefined as never, signal: controller.signal }
    const promise = runResilient(fn, opts)
    // First attempt fails synchronously, then we're in the backoff sleep — abort it.
    await Promise.resolve()
    controller.abort()
    await expect(promise).rejects.toBeDefined()
  }, 10_000)

  it("combines a caller signal with AbortSignal.timeout when the platform provides it", async () => {
    const breaker = fakeBreaker()
    const ctor = AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }
    const original = ctor.timeout
    // Force the hasTimeout branch in buildAttemptSignal (jsdom lacks it).
    ctor.timeout = () => new AbortController().signal
    try {
      const controller = new AbortController()
      let received: AbortSignal | undefined
      const fn = jest.fn(async (signal: AbortSignal) => {
        received = signal
        return "ok"
      })
      await runResilient(fn, { ...baseOpts(breaker), signal: controller.signal })
      expect(received).toBeInstanceOf(AbortSignal)
    } finally {
      ctor.timeout = original
    }
  })

  it("rethrows the caller's abort reason when it is an Error", async () => {
    const breaker = fakeBreaker()
    const controller = new AbortController()
    const reason = new Error("caller cancelled")
    controller.abort(reason)
    const fn = jest.fn(async () => "ok")
    await expect(
      runResilient(fn, { ...baseOpts(breaker), signal: controller.signal })
    ).rejects.toBe(reason)
    expect(fn).not.toHaveBeenCalled()
  })

  it("runs with no caller signal and an unbounded timeout (synthesizes a never-aborting signal)", async () => {
    const breaker = fakeBreaker()
    let received: AbortSignal | undefined
    const fn = jest.fn(async (signal: AbortSignal) => {
      received = signal
      return "ok"
    })
    // No caller signal + non-finite timeout → buildAttemptSignal has neither a
    // caller signal nor an AbortSignal.timeout, so it must mint a fresh one.
    const opts = { ...baseOpts(breaker), signal: undefined, timeoutMs: Number.POSITIVE_INFINITY }
    await expect(runResilient(fn, opts)).resolves.toBe("ok")
    expect(received).toBeInstanceOf(AbortSignal)
    expect(received!.aborted).toBe(false)
  })

  it("rethrows a DOMException AbortError when the caller's abort reason is not an Error", async () => {
    const breaker = fakeBreaker()
    const controller = new AbortController()
    controller.abort("cancelled-by-string") // non-Error reason → DOMException fallback
    const fn = jest.fn(async () => "ok")
    await expect(
      runResilient(fn, { ...baseOpts(breaker), signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(fn).not.toHaveBeenCalled()
  })

  it("clears the pending backoff timer and rejects when aborted mid-sleep", async () => {
    const breaker = fakeBreaker()
    const controller = new AbortController()
    const fn = jest.fn(async () => Promise.reject(new Error("ECONNRESET")))
    // No injected sleep → defaultSleep's real setTimeout runs (~1s backoff).
    const opts = { ...baseOpts(breaker), sleep: undefined as never, signal: controller.signal }
    const promise = runResilient(fn, opts)
    // Wait a real macrotask so the first attempt has failed and we are parked
    // inside defaultSleep's setTimeout before aborting — exercises onAbort.
    await new Promise((resolve) => setTimeout(resolve, 25))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(breaker.recordFailure).toHaveBeenCalledTimes(1)
  }, 10_000)

  it("propagates a caller abort during the work without retrying or recording", async () => {
    const breaker = fakeBreaker()
    const controller = new AbortController()
    const fn = jest.fn(
      (signal: AbortSignal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            {
              once: true,
            }
          )
        })
    )
    const promise = runResilient(fn, { ...baseOpts(breaker), signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(breaker.recordFailure).not.toHaveBeenCalled()
  })
})
