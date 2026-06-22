import { executeFallbackChain, type FallbackExecutorDeps } from "./fallback-executor"
import type { ModelMappingEntry } from "@cognia/provider-types/model-mapping"
import type { CircuitBreakerStateValue } from "@cognia/provider-types/circuit-breaker"

function entry(providerId: string, modelId: string): ModelMappingEntry {
  return { providerId, modelId }
}

interface DepsState {
  cb?: Record<string, CircuitBreakerStateValue>
}

function makeDeps(state: DepsState = {}) {
  const successes: string[] = []
  const failures: string[] = []
  const metrics: Array<Parameters<FallbackExecutorDeps["recordMetrics"]>[0]> = []
  const deps: FallbackExecutorDeps = {
    getCircuitBreakerState: (id) => state.cb?.[id] ?? "closed",
    recordSuccess: (id) => successes.push(id),
    recordFailure: (id) => failures.push(id),
    recordMetrics: (rec) => metrics.push(rec),
  }
  return { deps, successes, failures, metrics }
}

describe("executeFallbackChain", () => {
  it("returns the data from the primary entry when it succeeds", async () => {
    const { deps, successes, failures, metrics } = makeDeps()
    const exec = jest.fn(async () => "ok")
    const result = await executeFallbackChain(
      entry("openai", "gpt-4o"),
      [entry("anthropic", "claude"), entry("groq", "llama")],
      exec,
      deps,
      { timeoutMs: 0 }
    )
    expect(result.success).toBe(true)
    expect(result.data).toBe("ok")
    expect(result.providerId).toBe("openai")
    expect(exec).toHaveBeenCalledTimes(1)
    expect(successes).toEqual(["openai"])
    expect(failures).toEqual([])
    expect(metrics).toHaveLength(1)
    expect(metrics[0].success).toBe(true)
  })

  it("falls back to the next entry on a retryable error", async () => {
    const { deps, successes, failures } = makeDeps()
    const exec = jest
      .fn<Promise<string>, [string, string]>()
      .mockImplementationOnce(async () => {
        throw new Error("rate limit exceeded")
      })
      .mockImplementationOnce(async () => "second")

    const result = await executeFallbackChain(
      entry("openai", "gpt-4o"),
      [entry("anthropic", "claude")],
      exec,
      deps,
      { timeoutMs: 0 }
    )

    expect(result.success).toBe(true)
    expect(result.data).toBe("second")
    expect(result.providerId).toBe("anthropic")
    expect(exec).toHaveBeenCalledTimes(2)
    expect(failures).toEqual(["openai"])
    expect(successes).toEqual(["anthropic"])
  })

  it("propagates the last error when all entries fail", async () => {
    const { deps, failures } = makeDeps()
    const exec = jest
      .fn<Promise<string>, [string, string]>()
      .mockImplementationOnce(async () => {
        throw new Error("503 service unavailable")
      })
      .mockImplementationOnce(async () => {
        throw new Error("network error")
      })

    const result = await executeFallbackChain(
      entry("openai", "gpt-4o"),
      [entry("anthropic", "claude")],
      exec,
      deps,
      { timeoutMs: 0 }
    )

    expect(result.success).toBe(false)
    expect(result.error?.message).toBe("network error")
    expect(result.providerId).toBe("anthropic")
    expect(failures).toEqual(["openai", "anthropic"])
  })

  it("stops immediately on a non-retryable error", async () => {
    const { deps, failures } = makeDeps()
    const exec = jest.fn(async () => {
      throw new Error("401 unauthorized invalid api key")
    })
    const result = await executeFallbackChain(
      entry("openai", "gpt-4o"),
      [entry("anthropic", "claude")],
      exec,
      deps,
      { timeoutMs: 0 }
    )
    expect(result.success).toBe(false)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(failures).toEqual(["openai"])
  })

  it("skips entries whose circuit breaker is open", async () => {
    const { deps, failures, successes } = makeDeps({ cb: { openai: "open" } })
    const exec = jest.fn(async (pid: string) => {
      if (pid === "anthropic") return "from-anthropic"
      throw new Error("should not call openai")
    })

    const result = await executeFallbackChain(
      entry("openai", "gpt-4o"),
      [entry("anthropic", "claude")],
      exec,
      deps,
      { timeoutMs: 0 }
    )

    expect(result.success).toBe(true)
    expect(result.providerId).toBe("anthropic")
    expect(exec).toHaveBeenCalledTimes(1)
    expect(failures).toEqual([])
    expect(successes).toEqual(["anthropic"])
  })

  it("returns the synthetic 'no available providers' error when every entry is open", async () => {
    const { deps } = makeDeps({ cb: { openai: "open", anthropic: "open" } })
    const exec = jest.fn(async () => "x")
    const result = await executeFallbackChain(
      entry("openai", "gpt-4o"),
      [entry("anthropic", "claude")],
      exec,
      deps,
      { timeoutMs: 0 }
    )
    expect(result.success).toBe(false)
    expect(result.error?.message).toBe("No available providers in fallback chain")
    expect(exec).not.toHaveBeenCalled()
  })

  it("treats timeouts as retryable", async () => {
    jest.useFakeTimers()
    const { deps } = makeDeps()
    const exec = jest
      .fn<Promise<string>, [string, string]>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            // Resolves long after the 50ms timeout.
            setTimeout(() => resolve("never"), 1_000_000)
          })
      )
      .mockImplementationOnce(async () => "second")

    const promise = executeFallbackChain(
      entry("openai", "gpt-4o"),
      [entry("anthropic", "claude")],
      exec,
      deps,
      { timeoutMs: 50 }
    )

    // Push past the timeout deadline so the timer rejects the first call.
    await jest.advanceTimersByTimeAsync(60)
    const result = await promise

    jest.useRealTimers()

    expect(result.success).toBe(true)
    expect(result.providerId).toBe("anthropic")
  })

  it("respects the maxAttempts cap", async () => {
    const { deps } = makeDeps()
    const exec = jest.fn(async () => {
      throw new Error("rate limit")
    })
    const result = await executeFallbackChain(
      entry("a", "1"),
      [entry("b", "2"), entry("c", "3")],
      exec,
      deps,
      { timeoutMs: 0, maxAttempts: 2 }
    )
    expect(exec).toHaveBeenCalledTimes(2)
    expect(result.success).toBe(false)
    // Last attempted entry was 'b'.
    expect(result.providerId).toBe("b")
  })

  it("wraps non-Error rejections into Error instances", async () => {
    const { deps } = makeDeps()
    const exec = jest.fn(async () => {
      // Throwing a plain string — the executor must coerce.

      throw "boom 500"
    })
    const result = await executeFallbackChain(entry("a", "1"), [], exec, deps, { timeoutMs: 0 })
    expect(result.success).toBe(false)
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error?.message).toBe("boom 500")
  })
})
