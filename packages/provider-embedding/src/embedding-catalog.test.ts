import {
  RAG_EMBEDDING_PROVIDERS,
  getEmbeddingProviderDescriptor,
  embeddingProviderRequiresApiKey,
  embeddingProviderRequiresBaseURL,
  expectedEmbeddingDimension,
  isRagEmbeddingProvider,
  type RagEmbeddingProvider,
} from "./embedding-catalog"

describe("embedding-catalog", () => {
  it("exposes the canonical provider set including local + voyage", () => {
    expect(RAG_EMBEDDING_PROVIDERS).toEqual([
      "openai",
      "google",
      "cohere",
      "mistral",
      "voyage",
      "ollama",
      "lmstudio",
      "llamacpp",
      "vllm",
      "localai",
      "jan",
      "transformersjs",
    ])
  })

  it("does NOT expose azure/amazon-bedrock (documented follow-up)", () => {
    expect(isRagEmbeddingProvider("azure")).toBe(false)
    expect(isRagEmbeddingProvider("amazon-bedrock")).toBe(false)
  })

  it("isRagEmbeddingProvider narrows known ids", () => {
    expect(isRagEmbeddingProvider("ollama")).toBe(true)
    expect(isRagEmbeddingProvider("nope")).toBe(false)
  })

  it("every provider has a descriptor with a default model", () => {
    for (const id of RAG_EMBEDDING_PROVIDERS) {
      const d = getEmbeddingProviderDescriptor(id)
      expect(d.id).toBe(id)
      expect(d.defaultModel.length).toBeGreaterThan(0)
    }
  })

  it("cloud providers require an API key; local/browser do not", () => {
    expect(embeddingProviderRequiresApiKey("openai")).toBe(true)
    expect(embeddingProviderRequiresApiKey("voyage")).toBe(true)
    expect(embeddingProviderRequiresApiKey("ollama")).toBe(false)
    expect(embeddingProviderRequiresApiKey("lmstudio")).toBe(false)
    expect(embeddingProviderRequiresApiKey("transformersjs")).toBe(false)
  })

  it("local + ollama + voyage surface a base-URL input; pure cloud does not", () => {
    expect(embeddingProviderRequiresBaseURL("ollama")).toBe(true)
    expect(embeddingProviderRequiresBaseURL("lmstudio")).toBe(true)
    expect(embeddingProviderRequiresBaseURL("voyage")).toBe(true)
    expect(embeddingProviderRequiresBaseURL("openai")).toBe(false)
    expect(embeddingProviderRequiresBaseURL("transformersjs")).toBe(false)
  })

  describe("expectedEmbeddingDimension", () => {
    it("resolves known model dimensions", () => {
      expect(expectedEmbeddingDimension("openai", "text-embedding-3-small")).toBe(1536)
      expect(expectedEmbeddingDimension("openai", "text-embedding-3-large")).toBe(3072)
      expect(expectedEmbeddingDimension("transformersjs")).toBe(384)
    })

    it("falls back to the default-model dimension when no model is given", () => {
      expect(expectedEmbeddingDimension("google")).toBe(768)
    })

    it("returns undefined for unknown custom models", () => {
      expect(expectedEmbeddingDimension("vllm", "some-custom-model")).toBeUndefined()
      expect(
        expectedEmbeddingDimension("openai", "totally-unknown-model" as string)
      ).toBeUndefined()
    })
  })

  it("RagEmbeddingProvider type stays in sync with the runtime list", () => {
    const sample: RagEmbeddingProvider = "ollama"
    expect(RAG_EMBEDDING_PROVIDERS).toContain(sample)
  })
})
