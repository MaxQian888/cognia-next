import {
  runRoutedPrompt,
  type ResolvedCreds,
  type RoutedPromptDeps,
  type RoutingSelection,
} from "./ai-prompt-routed"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { ProviderOutcome } from "@/lib/claude/provider-telemetry"

function okClient(text: string, tokens = { inputTokens: 10, outputTokens: 5 }): LlmClient {
  return {
    complete: jest.fn().mockResolvedValue(text),
    getUsageSnapshot: () => ({ ...tokens, totalTokens: tokens.inputTokens + tokens.outputTokens }),
  }
}

function failClient(message: string): LlmClient {
  return {
    complete: jest.fn().mockRejectedValue(new Error(message)),
    getUsageSnapshot: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  }
}

function makeDeps(overrides: Partial<RoutedPromptDeps> = {}): {
  deps: RoutedPromptDeps
  outcomes: ProviderOutcome[]
} {
  const outcomes: ProviderOutcome[] = []
  const orderedCandidates = [
    { providerId: "p1", modelId: "m1" },
    { providerId: "p2", modelId: "m2" },
    { providerId: "p3", modelId: "m3" },
  ].map((entry) => ({
    ...entry,
    deploymentId: `${entry.providerId}::${entry.modelId}`,
    reasonCodes: [],
  }))
  const route: RoutingSelection = {
    decisionId: "decision",
    surface: "workflow",
    requested: { kind: "alias", alias: "fast" },
    strategy: "reliability",
    selected: orderedCandidates[0],
    orderedCandidates,
    reasonCodes: ["alias-match"],
    rejected: [],
    replayPolicy: "pre-commit-only",
    createdAt: 1,
  }
  const creds: ResolvedCreds = { protocol: "openai", apiKey: "k" }
  const deps: RoutedPromptDeps = {
    selectRoute: jest.fn().mockResolvedValue(route),
    resolveCreds: jest.fn().mockResolvedValue(creds),
    makeClient: jest.fn(() => okClient("hello")),
    recordOutcome: (o) => outcomes.push(o),
    getCircuitBreakerState: () => "closed",
    estimateCostUsd: jest.fn().mockResolvedValue(0.001),
    now: (() => {
      let t = 1000
      return () => (t += 50)
    })(),
    ...overrides,
  }
  return { deps, outcomes }
}

const baseInput = {
  modelAlias: "fast",
  userPrompt: "ping",
  log: jest.fn() as (level: "info" | "warn", message: string) => void,
}

describe("runRoutedPrompt", () => {
  it("returns the primary provider's completion with usage + cost", async () => {
    const { deps, outcomes } = makeDeps()
    const out = await runRoutedPrompt({ ...baseInput }, deps)

    expect(out.provider).toBe("p1")
    expect(out.model).toBe("m1")
    expect(out.completion).toBe("hello")
    expect(out.usage.totalTokens).toBe(15)
    expect(out.costUsd).toBe(0.001)
    expect(out.attempts).toBe(1)
    expect(out.routingReason).toBe("alias-match")
    expect(outcomes).toEqual([
      expect.objectContaining({
        providerId: "p1",
        ok: true,
        modelId: "m1",
        tokensUsed: 15,
        estimatedCostUsd: 0.001,
      }),
    ])
  })

  it("forwards apiFlavor from resolved credentials into createLlmClient", async () => {
    const makeClient = jest.fn(() => okClient("hello"))
    const { deps } = makeDeps({
      resolveCreds: jest.fn().mockResolvedValue({
        protocol: "openai",
        apiKey: "k",
        baseURL: "https://gateway.example/v1",
        apiFlavor: "responses",
      }),
      makeClient,
    })

    await runRoutedPrompt({ ...baseInput }, deps)

    expect(makeClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "m1",
        apiKey: "k",
        baseURL: "https://gateway.example/v1",
        apiFlavor: "responses",
      })
    )
  })

  it("walks the fallback chain when the primary fails and records both outcomes", async () => {
    const clients: Record<string, LlmClient> = {
      m1: failClient("boom 500"),
      m2: okClient("from p2"),
    }
    const { deps, outcomes } = makeDeps({
      makeClient: jest.fn((cfg) => clients[cfg.model]),
    })
    const log = jest.fn()
    const out = await runRoutedPrompt({ ...baseInput, log }, deps)

    expect(out.provider).toBe("p2")
    expect(out.completion).toBe("from p2")
    expect(out.attempts).toBe(2)
    expect(outcomes.map((o) => [o.providerId, o.ok])).toEqual([
      ["p1", false],
      ["p2", true],
    ])
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("p1 failed"))
  })

  it("skips providers with missing credentials instead of aborting the walk", async () => {
    const { deps } = makeDeps({
      resolveCreds: jest.fn(async (id: string) =>
        id === "p1" ? null : { protocol: "openai" as const, apiKey: "k" }
      ),
      makeClient: jest.fn(() => okClient("via p2")),
    })
    const log = jest.fn()
    const out = await runRoutedPrompt({ ...baseInput, log }, deps)

    expect(out.provider).toBe("p2")
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("p1 (no credentials)"))
  })

  it("skips providers whose circuit breaker is open", async () => {
    const { deps } = makeDeps({
      getCircuitBreakerState: (id) => (id === "p1" ? "open" : "closed"),
      makeClient: jest.fn(() => okClient("via p2")),
    })
    const log = jest.fn()
    const out = await runRoutedPrompt({ ...baseInput, log }, deps)

    expect(out.provider).toBe("p2")
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("circuit open"))
  })

  it("throws a non-retryable error when no route exists", async () => {
    const { deps } = makeDeps({ selectRoute: jest.fn().mockResolvedValue(null) })
    await expect(runRoutedPrompt({ ...baseInput }, deps)).rejects.toThrow(/no provider route/)
    try {
      await runRoutedPrompt({ ...baseInput }, deps)
    } catch (err) {
      expect((err as Error & { retryable?: boolean }).retryable).toBe(false)
    }
  })

  it("throws a non-retryable error when no provider in the chain has credentials", async () => {
    const { deps } = makeDeps({ resolveCreds: jest.fn().mockResolvedValue(null) })
    await expect(runRoutedPrompt({ ...baseInput }, deps)).rejects.toThrow(/no usable provider/)
  })

  it("aggregates errors when every provider fails", async () => {
    const { deps, outcomes } = makeDeps({
      makeClient: jest.fn(() => failClient("rate limit")),
    })
    await expect(runRoutedPrompt({ ...baseInput }, deps)).rejects.toThrow(
      /all providers failed[\s\S]*p1:m1[\s\S]*p2:m2[\s\S]*p3:m3/
    )
    expect(outcomes.every((o) => !o.ok)).toBe(true)
    expect(outcomes).toHaveLength(3)
  })

  it("streams deltas through onDelta when the client supports stream()", async () => {
    const streamingClient: LlmClient = {
      complete: jest.fn().mockResolvedValue("should not be used"),

      stream: async function* () {
        yield "he"
        yield "llo"
      },
      getUsageSnapshot: () => ({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
    }
    const { deps } = makeDeps({ makeClient: jest.fn(() => streamingClient) })
    const deltas: string[] = []
    const out = await runRoutedPrompt({ ...baseInput, onDelta: (d) => deltas.push(d) }, deps)

    expect(deltas).toEqual(["he", "llo"])
    expect(out.completion).toBe("hello")
    expect(streamingClient.complete).not.toHaveBeenCalled()
  })

  it("does not replay another provider after the first visible delta", async () => {
    const makeClient = jest.fn(() => ({
      complete: jest.fn(),
      stream: async function* () {
        yield "visible"
        throw new Error("stream failed")
      },
      getUsageSnapshot: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    }))
    const { deps } = makeDeps({ makeClient })

    await expect(runRoutedPrompt({ ...baseInput, onDelta: jest.fn() }, deps)).rejects.toThrow(
      /all providers failed/
    )
    expect(makeClient).toHaveBeenCalledTimes(1)
  })

  it("falls back to complete() when onDelta is absent", async () => {
    const client = okClient("plain")
    const { deps } = makeDeps({ makeClient: jest.fn(() => client) })
    const out = await runRoutedPrompt({ ...baseInput }, deps)
    expect(out.completion).toBe("plain")
    expect(client.complete).toHaveBeenCalled()
  })

  it("uses the plan's single primary only once", async () => {
    const makeClient = jest.fn(() => failClient("x"))
    const selected = {
      providerId: "p1",
      modelId: "m1",
      deploymentId: "p1::m1",
      reasonCodes: [],
    }
    const { deps } = makeDeps({
      selectRoute: jest.fn().mockResolvedValue({
        decisionId: "single",
        surface: "workflow",
        requested: { kind: "alias", alias: "fast" },
        strategy: "reliability",
        selected,
        orderedCandidates: [selected],
        reasonCodes: ["alias-match"],
        rejected: [],
        replayPolicy: "pre-commit-only",
        createdAt: 1,
      }),
      makeClient,
    })
    await expect(runRoutedPrompt({ ...baseInput }, deps)).rejects.toThrow(/all providers failed/)
    expect(makeClient).toHaveBeenCalledTimes(1)
  })
})
