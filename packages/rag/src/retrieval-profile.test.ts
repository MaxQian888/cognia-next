import {
  createRetrievalProfile,
  fingerprintRetrievalProfile,
  isLocalEmbeddingProvider,
} from "./retrieval-profile"

describe("RetrievalProfileV1", () => {
  it("classifies provider locality from the canonical embedding catalog", () => {
    expect(isLocalEmbeddingProvider("ollama")).toBe(true)
    expect(isLocalEmbeddingProvider("lmstudio")).toBe(true)
    expect(isLocalEmbeddingProvider("transformersjs")).toBe(true)
    expect(isLocalEmbeddingProvider("openai")).toBe(false)
    expect(isLocalEmbeddingProvider("amazon-bedrock")).toBe(false)
  })

  it("produces the same fingerprint regardless of object key insertion order", async () => {
    const profile = createRetrievalProfile({
      id: "profile-1",
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      vector: { backend: "native", collectionPolicy: "generation" },
    })
    const reordered = {
      ...profile,
      budgets: {
        tokenBudget: profile.budgets.tokenBudget,
        timeoutMs: profile.budgets.timeoutMs,
        topK: profile.budgets.topK,
      },
    }

    await expect(fingerprintRetrievalProfile(profile)).resolves.toBe(
      await fingerprintRetrievalProfile(reordered)
    )
  })
})
