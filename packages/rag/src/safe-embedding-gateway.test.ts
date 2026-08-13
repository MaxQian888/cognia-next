import { createRetrievalProfile } from "./retrieval-profile"
import {
  EmbeddingSafetyError,
  createSafeEmbeddingGateway,
  type SafeEmbeddingCache,
} from "./safe-embedding-gateway"

describe("SafeEmbeddingGateway", () => {
  it("redacts cloud-bound text and returns a content-free identity", async () => {
    const embed = jest.fn(async () => [0.1, 0.2])
    const gateway = createSafeEmbeddingGateway({ embed })
    const profile = createRetrievalProfile({
      id: "cloud",
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      vector: { backend: "native", collectionPolicy: "generation" },
    })

    const result = await gateway.embed({
      profile,
      purpose: "query",
      text: "Contact alice@example.com",
    })

    expect(embed).toHaveBeenCalledWith(
      "Contact <EMAIL_001>",
      expect.objectContaining({ provider: "openai", purpose: "query" })
    )
    expect(result).toEqual(
      expect.objectContaining({
        embedding: [0.1, 0.2],
        provider: "openai",
        model: "text-embedding-3-small",
        redacted: true,
      })
    )
    expect(result).not.toHaveProperty("text")
    expect(result.safeTextHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("preserves text only for a local provider when the profile explicitly allows it", async () => {
    const embed = jest.fn(async () => [1])
    const gateway = createSafeEmbeddingGateway({ embed })
    const profile = createRetrievalProfile({
      id: "local",
      embedding: { provider: "ollama", model: "nomic-embed-text" },
      vector: { backend: "native", collectionPolicy: "generation" },
      safety: { localOriginalText: "allow", cloudText: "redact-fail-closed" },
    })

    await gateway.embed({ profile, purpose: "document", text: "alice@example.com" })

    expect(embed).toHaveBeenCalledWith(
      "alice@example.com",
      expect.objectContaining({ provider: "ollama" })
    )
  })

  it("fails closed before calling a remote provider when redaction is still unsafe", async () => {
    const embed = jest.fn(async () => [1])
    const gateway = createSafeEmbeddingGateway({
      embed,
      redact: () => ({ redacted: "still unsafe", map: {} }),
      isSafe: () => false,
    })
    const profile = createRetrievalProfile({
      id: "cloud",
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      vector: { backend: "native", collectionPolicy: "generation" },
    })

    await expect(
      gateway.embed({ profile, purpose: "query", text: "unsafe" })
    ).rejects.toBeInstanceOf(EmbeddingSafetyError)
    expect(embed).not.toHaveBeenCalled()
  })

  it("reuses embeddings by provider, model, and safe-text hash", async () => {
    const values = new Map<string, number[]>()
    const cache: SafeEmbeddingCache = {
      get: async (key) => values.get(key),
      set: async (key, embedding) => void values.set(key, embedding),
    }
    const embed = jest.fn(async () => [0.4])
    const gateway = createSafeEmbeddingGateway({ embed, cache })
    const profile = createRetrievalProfile({
      id: "cloud",
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      vector: { backend: "native", collectionPolicy: "generation" },
    })

    const first = await gateway.embed({ profile, purpose: "query", text: "hello" })
    const second = await gateway.embed({ profile, purpose: "document", text: "hello" })

    expect(first.cacheHit).toBe(false)
    expect(second.cacheHit).toBe(true)
    expect(embed).toHaveBeenCalledTimes(1)
  })
})
