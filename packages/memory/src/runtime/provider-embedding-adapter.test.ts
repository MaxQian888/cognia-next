const mockGenerateEmbedding = jest.fn()

jest.mock("@cognia/provider-embedding/embedding", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}))

import type { EmbeddingModelV3 } from "@ai-sdk/provider"

import { createProviderEmbeddingAdapter } from "./provider-embedding-adapter"

describe("createProviderEmbeddingAdapter", () => {
  beforeEach(() => {
    mockGenerateEmbedding.mockReset()
  })

  it("returns the embedding vector from the configured provider", async () => {
    const config = {
      provider: "amazon-bedrock" as const,
      model: "amazon.titan-embed-text-v2:0",
      bedrock: { authMode: "default-chain" as const, region: "us-west-2" },
      // Opaque to this adapter — it only forwards the config to
      // `generateEmbedding`, so a full EmbeddingModelV3 would be noise.
      bedrockModel: { specificationVersion: "v3" as const } as unknown as EmbeddingModelV3,
    }
    mockGenerateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2], usage: undefined })

    await expect(createProviderEmbeddingAdapter(config)("memory query")).resolves.toEqual([
      0.1, 0.2,
    ])
    expect(mockGenerateEmbedding).toHaveBeenCalledWith("memory query", config)
  })

  it("propagates provider failures so the composition root can degrade to BM25", async () => {
    mockGenerateEmbedding.mockRejectedValue(new Error("embedding unavailable"))

    await expect(
      createProviderEmbeddingAdapter({ provider: "openai", model: "text-embedding-3-small" })(
        "query"
      )
    ).rejects.toThrow("embedding unavailable")
  })

  it("redacts PII before sending a memory query to a cloud embedding provider", async () => {
    const config = { provider: "openai" as const, model: "text-embedding-3-small" }
    mockGenerateEmbedding.mockResolvedValue({ embedding: [0.3], usage: undefined })

    await createProviderEmbeddingAdapter(config)("Remember alice@example.com")

    expect(mockGenerateEmbedding).toHaveBeenCalledWith("Remember <EMAIL_001>", config)
  })
})
