import {
  getModelContextLimits,
  getModelMaxTokens,
  getRAGLogger,
  getStorageBackendReadiness,
  proxyFetch,
  resetRAGRuntimeAdaptersForTesting,
  setRAGRuntimeAdapters,
  updateStorageBackendReadiness,
} from "./runtime-adapters"

describe("RAG runtime adapters", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    resetRAGRuntimeAdaptersForTesting()
    globalThis.fetch = jest.fn().mockResolvedValue(new Response("ok")) as unknown as typeof fetch
  })

  afterEach(() => {
    resetRAGRuntimeAdaptersForTesting()
    globalThis.fetch = originalFetch
  })

  it("uses safe defaults for logger, fetch, model limits, and readiness", async () => {
    expect(() => getRAGLogger().warn("noop")).not.toThrow()
    await expect(proxyFetch("https://example.com")).resolves.toBeInstanceOf(Response)
    expect(getModelMaxTokens("gpt-4o")).toBe(128000)
    expect(getModelContextLimits("unknown-model")).toEqual({
      maxTokens: 100000,
      reserveTokens: 2000,
    })
    expect(getStorageBackendReadiness("vector-qdrant")).toBeUndefined()
  })

  it("forwards logger and fetch calls through injected adapters", async () => {
    const logger = { warn: jest.fn(), error: jest.fn() }
    const fetcher = jest.fn().mockResolvedValue(new Response("wired"))

    setRAGRuntimeAdapters({ logger, proxyFetch: fetcher })

    getRAGLogger().warn("warned", { source: "test" })
    getRAGLogger().error("failed", new Error("boom"))
    await proxyFetch("https://example.com", { method: "POST" })

    expect(logger.warn).toHaveBeenCalledWith("warned", { source: "test" })
    expect(logger.error).toHaveBeenCalledWith("failed", expect.any(Error), undefined)
    expect(fetcher).toHaveBeenCalledWith("https://example.com", { method: "POST" })
  })

  it("stores readiness records locally", () => {
    updateStorageBackendReadiness({
      id: "vector-qdrant",
      state: "degraded",
      lastCheckedAt: "2026-03-19T10:30:00.000Z",
      diagnostic: {
        code: "roundtrip-failed",
        message: "Qdrant readiness failed",
        at: "2026-03-19T10:30:00.000Z",
      },
    })

    expect(getStorageBackendReadiness("vector-qdrant")).toMatchObject({
      id: "vector-qdrant",
      label: "Qdrant",
      category: "vector-provider",
      state: "degraded",
    })
  })
})
