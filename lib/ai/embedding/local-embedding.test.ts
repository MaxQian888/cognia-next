import {
  isOpenAICompatibleEmbeddingProvider,
  resolveLocalEmbeddingBaseURL,
  OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS,
} from "./local-embedding"

describe("isOpenAICompatibleEmbeddingProvider", () => {
  it("accepts the OpenAI-compatible local engines", () => {
    for (const p of OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS) {
      expect(isOpenAICompatibleEmbeddingProvider(p)).toBe(true)
    }
  })

  it("rejects ollama (native path) and cloud providers", () => {
    expect(isOpenAICompatibleEmbeddingProvider("ollama")).toBe(false)
    expect(isOpenAICompatibleEmbeddingProvider("openai")).toBe(false)
    expect(isOpenAICompatibleEmbeddingProvider("unknown")).toBe(false)
  })
})

describe("resolveLocalEmbeddingBaseURL", () => {
  it("uses the catalog default (normalised to /v1) when no base URL is given", () => {
    expect(resolveLocalEmbeddingBaseURL("lmstudio")).toBe("http://localhost:1234/v1")
    expect(resolveLocalEmbeddingBaseURL("vllm")).toBe("http://localhost:8000/v1")
  })

  it("honours an explicit base URL and appends /v1 when missing", () => {
    expect(resolveLocalEmbeddingBaseURL("lmstudio", "http://10.0.0.2:1234")).toBe(
      "http://10.0.0.2:1234/v1"
    )
    expect(resolveLocalEmbeddingBaseURL("lmstudio", "http://10.0.0.2:1234/v1")).toBe(
      "http://10.0.0.2:1234/v1"
    )
  })

  it("falls back to a generic localhost endpoint for an unknown local id", () => {
    expect(resolveLocalEmbeddingBaseURL("mystery")).toBe("http://localhost:8000/v1")
  })
})
