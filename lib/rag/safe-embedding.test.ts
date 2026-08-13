const mockGenerateEmbedding = jest.fn()

jest.mock("@cognia/provider-embedding/embedding", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}))

import { generateSafeEmbedding } from "./safe-embedding"

describe("generateSafeEmbedding", () => {
  beforeEach(() => mockGenerateEmbedding.mockReset())

  it("redacts cloud-bound application queries before invoking the transport", async () => {
    mockGenerateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] })

    const result = await generateSafeEmbedding("alice@example.com", {
      profileId: "chat",
      purpose: "query",
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: "secret",
      },
      vectorBackend: "native",
    })

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      "<EMAIL_001>",
      expect.objectContaining({ provider: "openai", model: "text-embedding-3-small" })
    )
    expect(result.embedding).toEqual([0.1, 0.2])
    expect(result.redacted).toBe(true)
  })

  it("only preserves local text when the caller explicitly opts in", async () => {
    mockGenerateEmbedding.mockResolvedValue({ embedding: [1] })

    await generateSafeEmbedding("alice@example.com", {
      profileId: "local",
      purpose: "document",
      embedding: { provider: "ollama", model: "nomic-embed-text", apiKey: "" },
      vectorBackend: "native",
      allowLocalOriginalText: true,
    })

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      "alice@example.com",
      expect.objectContaining({ provider: "ollama" })
    )
  })
})
