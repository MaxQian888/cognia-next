import {
  DEFAULT_AGENT_TIMEOUT_MS,
  TimeoutError,
  withTimeout,
  withTimeoutOrFallback,
} from "./with-timeout"

describe("withTimeout", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("resolves with the original value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "test")).resolves.toBe(42)
  })

  it("rejects with TimeoutError when the promise outlasts the budget", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 5000))
    const wrapped = withTimeout(slow, 1000, "slow-agent")
    jest.advanceTimersByTime(1000)
    await expect(wrapped).rejects.toBeInstanceOf(TimeoutError)
  })

  it("includes the label and timeout in the error message", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000))
    const wrapped = withTimeout(slow, 250, "knowledge-agent")
    jest.advanceTimersByTime(250)
    await expect(wrapped).rejects.toThrow(/knowledge-agent timed out after 250ms/)
  })

  it("propagates the original rejection when the promise rejects in time", async () => {
    const promise = Promise.reject(new Error("provider 500"))
    await expect(withTimeout(promise, 1000, "ok")).rejects.toThrow("provider 500")
  })

  it("returns the original promise when timeoutMs is non-positive", async () => {
    await expect(withTimeout(Promise.resolve(7), 0, "no-timeout")).resolves.toBe(7)
    await expect(withTimeout(Promise.resolve(7), -1, "no-timeout")).resolves.toBe(7)
  })
})

describe("withTimeoutOrFallback", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("returns the resolved value with no error on success", async () => {
    const out = await withTimeoutOrFallback(async () => "ok", "agent", { fallback: "fallback" })
    expect(out).toEqual({ value: "ok", error: null })
  })

  it("returns fallback + error message on timeout", async () => {
    const onError = jest.fn()
    const promise = withTimeoutOrFallback(
      async () => {
        await new Promise((r) => setTimeout(r, 5000))
        return "real"
      },
      "agent",
      { fallback: "default", timeoutMs: 100, onError }
    )
    jest.advanceTimersByTime(100)
    const out = await promise
    expect(out.value).toBe("default")
    expect(out.error).toMatch(/agent timed out after 100ms/)
    expect(onError).toHaveBeenCalledWith("agent", expect.stringContaining("timed out"))
  })

  it("returns fallback + error message on rejection (non-timeout)", async () => {
    const out = await withTimeoutOrFallback(
      async () => {
        throw new Error("network")
      },
      "agent",
      { fallback: "default" }
    )
    expect(out).toEqual({ value: "default", error: "network" })
  })

  it("exports DEFAULT_AGENT_TIMEOUT_MS = 90s", () => {
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(90_000)
  })
})
