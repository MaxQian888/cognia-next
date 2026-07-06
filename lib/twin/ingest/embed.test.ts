// Mock the embedding module *before* importing the unit under test so the
// import chain picks up the mock. embed.ts only consumes generateEmbeddings.
const mockGenerateEmbeddings = jest.fn()
jest.mock("@cognia/provider-embedding/embedding", () => ({
  generateEmbeddings: (...args: unknown[]) => mockGenerateEmbeddings(...args),
}))

import { embedRedactedChunks, __resetTwinEmbeddingCache, type EmbeddingConfig } from "./embed"

const baseConfig: EmbeddingConfig = {
  provider: "openai",
  model: "text-embedding-3-small",
  apiKey: "sk-test",
}

beforeEach(() => {
  mockGenerateEmbeddings.mockReset()
  // The module-local embedding cache is a singleton across cases — reset it so
  // texts reused between `it` blocks don't leak cache hits and skew call counts.
  __resetTwinEmbeddingCache()
})

describe("embedRedactedChunks", () => {
  it("returns immediately for empty input without calling the upstream", async () => {
    const result = await embedRedactedChunks([], baseConfig)
    expect(result).toEqual({ embeddings: [], tokensUsed: 0 })
    expect(mockGenerateEmbeddings).not.toHaveBeenCalled()
  })

  it("throws when the provider returns fewer vectors than the batch", async () => {
    // Regression: an under-length response used to flow `undefined` vectors into
    // the cache + remote upsert. Fail loudly so the per-source catch isolates it.
    mockGenerateEmbeddings.mockResolvedValueOnce({
      embeddings: [[1, 2]], // 1 vector for 2 inputs
      usage: { tokens: 10 },
    })
    await expect(embedRedactedChunks(["a", "b"], baseConfig)).rejects.toThrow(
      /returned 1 vectors for a batch of 2/
    )
  })

  it("uses the default batch size of 64 (1 batch for 50 inputs)", async () => {
    mockGenerateEmbeddings.mockResolvedValueOnce({
      embeddings: Array.from({ length: 50 }, (_, i) => [i, i, i]),
      usage: { tokens: 100 },
    })
    const texts = Array.from({ length: 50 }, (_, i) => `chunk ${i}`)
    const result = await embedRedactedChunks(texts, baseConfig)
    expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1)
    expect(result.embeddings).toHaveLength(50)
    expect(result.tokensUsed).toBe(100)
  })

  it("splits 130 inputs across 3 batches at the default batch size", async () => {
    mockGenerateEmbeddings
      .mockResolvedValueOnce({
        embeddings: Array.from({ length: 64 }, () => [0]),
        usage: { tokens: 60 },
      })
      .mockResolvedValueOnce({
        embeddings: Array.from({ length: 64 }, () => [1]),
        usage: { tokens: 60 },
      })
      .mockResolvedValueOnce({
        embeddings: Array.from({ length: 2 }, () => [2]),
        usage: { tokens: 5 },
      })

    const texts = Array.from({ length: 130 }, (_, i) => `t${i}`)
    const result = await embedRedactedChunks(texts, baseConfig)

    expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(3)
    // batch 1: indices 0..63 (64 items)
    expect(mockGenerateEmbeddings.mock.calls[0][0] as string[]).toHaveLength(64)
    // batch 2: indices 64..127 (64 items)
    expect(mockGenerateEmbeddings.mock.calls[1][0] as string[]).toHaveLength(64)
    // batch 3: indices 128..129 (2 items)
    expect(mockGenerateEmbeddings.mock.calls[2][0] as string[]).toHaveLength(2)
    expect(result.embeddings).toHaveLength(130)
    expect(result.tokensUsed).toBe(125)
  })

  it("respects an explicit batchSize", async () => {
    mockGenerateEmbeddings.mockResolvedValue({
      embeddings: [[0.1], [0.2], [0.3]],
      usage: { tokens: 10 },
    })
    const texts = Array.from({ length: 9 }, (_, i) => `t${i}`)
    await embedRedactedChunks(texts, { ...baseConfig, batchSize: 3 })
    expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(3)
  })

  it("clamps batchSize <= 0 up to 1 so the loop still terminates", async () => {
    mockGenerateEmbeddings.mockResolvedValue({ embeddings: [[1]], usage: undefined })
    await embedRedactedChunks(["a", "b"], { ...baseConfig, batchSize: 0 })
    // batchSize clamped to 1 → 2 batches.
    expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(2)
  })

  it("forwards baseURL to the upstream call", async () => {
    mockGenerateEmbeddings.mockResolvedValue({ embeddings: [[0]], usage: undefined })
    await embedRedactedChunks(["x"], { ...baseConfig, baseURL: "https://proxy.example/v1" })
    const callConfig = mockGenerateEmbeddings.mock.calls[0][1] as Record<string, unknown>
    expect(callConfig.baseURL).toBe("https://proxy.example/v1")
    expect(callConfig.provider).toBe("openai")
    expect(callConfig.model).toBe("text-embedding-3-small")
    expect(callConfig.apiKey).toBe("sk-test")
  })

  it("tolerates missing usage.tokens on a batch (treats as 0)", async () => {
    mockGenerateEmbeddings
      .mockResolvedValueOnce({ embeddings: [[1], [2]], usage: { tokens: 7 } })
      .mockResolvedValueOnce({ embeddings: [[3]], usage: undefined })
    const result = await embedRedactedChunks(["a", "b", "c"], { ...baseConfig, batchSize: 2 })
    expect(result.tokensUsed).toBe(7)
    expect(result.embeddings).toEqual([[1], [2], [3]])
  })

  it("preserves vector order across batches", async () => {
    mockGenerateEmbeddings
      .mockResolvedValueOnce({
        embeddings: [
          [1, 0, 0],
          [0, 1, 0],
        ],
        usage: { tokens: 1 },
      })
      .mockResolvedValueOnce({ embeddings: [[0, 0, 1]], usage: { tokens: 1 } })
    const result = await embedRedactedChunks(["x", "y", "z"], { ...baseConfig, batchSize: 2 })
    expect(result.embeddings).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])
  })

  it("embeds duplicate texts only once but returns one vector per input", async () => {
    // Three inputs, two of which are identical — upstream should see 2 distinct.
    mockGenerateEmbeddings.mockResolvedValueOnce({
      embeddings: [
        [1, 1],
        [2, 2],
      ],
      usage: { tokens: 9 },
    })
    const result = await embedRedactedChunks(["dup", "unique", "dup"], baseConfig)
    expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1)
    expect(mockGenerateEmbeddings.mock.calls[0][0] as string[]).toEqual(["dup", "unique"])
    // Both "dup" slots resolve to the same vector; order preserved.
    expect(result.embeddings).toEqual([
      [1, 1],
      [2, 2],
      [1, 1],
    ])
    expect(result.tokensUsed).toBe(9)
  })

  it("serves cached vectors on a second call without re-embedding (idempotent re-import)", async () => {
    mockGenerateEmbeddings.mockResolvedValueOnce({
      embeddings: [
        [1, 0],
        [0, 1],
      ],
      usage: { tokens: 4 },
    })
    const first = await embedRedactedChunks(["alpha", "beta"], baseConfig)
    expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1)

    // Same texts again — fully cached, no upstream call, no token spend.
    const second = await embedRedactedChunks(["alpha", "beta"], baseConfig)
    expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1)
    expect(second.embeddings).toEqual(first.embeddings)
    expect(second.tokensUsed).toBe(0)
  })

  it("only embeds the cache-miss text on a partially-cached call", async () => {
    mockGenerateEmbeddings.mockResolvedValueOnce({ embeddings: [[1, 0]], usage: { tokens: 2 } })
    await embedRedactedChunks(["warm"], baseConfig)

    mockGenerateEmbeddings.mockResolvedValueOnce({ embeddings: [[0, 1]], usage: { tokens: 3 } })
    const result = await embedRedactedChunks(["warm", "cold"], baseConfig)
    // Second call embeds only "cold"; "warm" comes from cache.
    expect(mockGenerateEmbeddings.mock.calls[1][0] as string[]).toEqual(["cold"])
    expect(result.embeddings).toEqual([
      [1, 0],
      [0, 1],
    ])
    expect(result.tokensUsed).toBe(3)
  })

  it("keys the cache by provider+model so a different model re-embeds the same text", async () => {
    mockGenerateEmbeddings.mockResolvedValueOnce({ embeddings: [[1, 0, 0]], usage: { tokens: 1 } })
    await embedRedactedChunks(["shared"], baseConfig)

    mockGenerateEmbeddings.mockResolvedValueOnce({
      embeddings: [[9, 9, 9, 9]],
      usage: { tokens: 1 },
    })
    const other = await embedRedactedChunks(["shared"], {
      ...baseConfig,
      model: "text-embedding-3-large",
    })
    // Different model → cache miss → upstream called again (correct dimension).
    expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(2)
    expect(other.embeddings).toEqual([[9, 9, 9, 9]])
  })
})
