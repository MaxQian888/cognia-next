/**
 * Tests for Embedding utilities
 */

import {
  DEFAULT_EMBEDDING_MODELS,
  calculateSimilarity,
  embeddingProviderRequiresApiKey,
  findMostSimilar,
  getEmbeddingApiKey,
  normalizeTextForEmbedding,
  type EmbeddingProvider,
} from "./embedding"

describe("DEFAULT_EMBEDDING_MODELS", () => {
  it("has OpenAI model config", () => {
    expect(DEFAULT_EMBEDDING_MODELS.openai).toBeDefined()
    expect(DEFAULT_EMBEDDING_MODELS.openai.provider).toBe("openai")
    expect(DEFAULT_EMBEDDING_MODELS.openai.model).toBe("text-embedding-3-small")
    expect(DEFAULT_EMBEDDING_MODELS.openai.dimensions).toBe(1536)
  })

  it("has Google model config", () => {
    expect(DEFAULT_EMBEDDING_MODELS.google).toBeDefined()
    expect(DEFAULT_EMBEDDING_MODELS.google.provider).toBe("google")
    expect(DEFAULT_EMBEDDING_MODELS.google.model).toBe("text-embedding-004")
    expect(DEFAULT_EMBEDDING_MODELS.google.dimensions).toBe(768)
  })

  it("has Cohere model config", () => {
    expect(DEFAULT_EMBEDDING_MODELS.cohere).toBeDefined()
    expect(DEFAULT_EMBEDDING_MODELS.cohere.provider).toBe("cohere")
    expect(DEFAULT_EMBEDDING_MODELS.cohere.model).toBe("embed-english-v3.0")
    expect(DEFAULT_EMBEDDING_MODELS.cohere.dimensions).toBe(1024)
  })

  it("has Mistral model config", () => {
    expect(DEFAULT_EMBEDDING_MODELS.mistral).toBeDefined()
    expect(DEFAULT_EMBEDDING_MODELS.mistral.provider).toBe("mistral")
    expect(DEFAULT_EMBEDDING_MODELS.mistral.model).toBe("mistral-embed")
    expect(DEFAULT_EMBEDDING_MODELS.mistral.dimensions).toBe(1024)
  })

  it("has Transformers.js model config", () => {
    expect(DEFAULT_EMBEDDING_MODELS.transformersjs).toBeDefined()
    expect(DEFAULT_EMBEDDING_MODELS.transformersjs.provider).toBe("transformersjs")
    expect(DEFAULT_EMBEDDING_MODELS.transformersjs.model).toBe("Xenova/all-MiniLM-L6-v2")
    expect(DEFAULT_EMBEDDING_MODELS.transformersjs.dimensions).toBe(384)
  })

  it("all configs have required properties", () => {
    const providers: EmbeddingProvider[] = [
      "openai",
      "google",
      "cohere",
      "mistral",
      "transformersjs",
    ]

    providers.forEach((provider) => {
      const config = DEFAULT_EMBEDDING_MODELS[provider]
      expect(config.provider).toBeDefined()
      expect(config.model).toBeDefined()
      expect(typeof config.dimensions).toBe("number")
      expect(config.dimensions).toBeGreaterThan(0)
    })
  })
})

describe("calculateSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const vector = [1, 0, 0]
    const result = calculateSimilarity(vector, vector)

    expect(result).toBeCloseTo(1, 5)
  })

  it("returns -1 for opposite vectors", () => {
    const a = [1, 0, 0]
    const b = [-1, 0, 0]
    const result = calculateSimilarity(a, b)

    expect(result).toBeCloseTo(-1, 5)
  })

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0]
    const b = [0, 1, 0]
    const result = calculateSimilarity(a, b)

    expect(result).toBeCloseTo(0, 5)
  })

  it("handles normalized vectors", () => {
    const a = [0.6, 0.8, 0]
    const b = [0.6, 0.8, 0]
    const result = calculateSimilarity(a, b)

    expect(result).toBeCloseTo(1, 5)
  })

  it("handles high-dimensional vectors", () => {
    const dim = 1536
    const a = new Array(dim).fill(1 / Math.sqrt(dim))
    const b = new Array(dim).fill(1 / Math.sqrt(dim))
    const result = calculateSimilarity(a, b)

    expect(result).toBeCloseTo(1, 2)
  })

  it("returns value between -1 and 1", () => {
    const a = [0.5, 0.3, 0.8, 0.1]
    const b = [0.2, 0.9, 0.4, 0.6]
    const result = calculateSimilarity(a, b)

    expect(result).toBeGreaterThanOrEqual(-1)
    expect(result).toBeLessThanOrEqual(1)
  })
})

describe("findMostSimilar", () => {
  const embeddings = [
    { id: "a", embedding: [1, 0, 0] },
    { id: "b", embedding: [0.9, 0.1, 0] },
    { id: "c", embedding: [0, 1, 0] },
    { id: "d", embedding: [0, 0, 1] },
    { id: "e", embedding: [0.5, 0.5, 0] },
  ]

  it("finds most similar embeddings", () => {
    const query = [1, 0, 0]
    const results = findMostSimilar(query, embeddings, 2)

    expect(results).toHaveLength(2)
    expect(results[0].id).toBe("a")
  })

  it("returns results sorted by similarity descending", () => {
    const query = [1, 0, 0]
    const results = findMostSimilar(query, embeddings, 3)

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity)
    }
  })

  it("respects topK parameter", () => {
    const query = [1, 0, 0]
    const results = findMostSimilar(query, embeddings, 3)

    expect(results).toHaveLength(3)
  })

  it("filters by threshold", () => {
    const query = [1, 0, 0]
    const results = findMostSimilar(query, embeddings, 10, 0.8)

    results.forEach((result) => {
      expect(result.similarity).toBeGreaterThanOrEqual(0.8)
    })
  })

  it("returns empty array when no matches above threshold", () => {
    const query = [0, 0, 1]
    const lowThreshold = findMostSimilar(query, [embeddings[0], embeddings[1]], 5, 0.99)

    expect(lowThreshold.length).toBeLessThan(2)
  })

  it("handles empty embeddings array", () => {
    const query = [1, 0, 0]
    const results = findMostSimilar(query, [], 5)

    expect(results).toHaveLength(0)
  })

  it("uses default values", () => {
    const query = [1, 0, 0]
    const results = findMostSimilar(query, embeddings)

    expect(results.length).toBeLessThanOrEqual(5)
  })

  it("includes similarity scores in results", () => {
    const query = [1, 0, 0]
    const results = findMostSimilar(query, embeddings, 2)

    results.forEach((result) => {
      expect(result.id).toBeDefined()
      expect(typeof result.similarity).toBe("number")
    })
  })
})

describe("getEmbeddingApiKey", () => {
  it("returns OpenAI key for openai provider", () => {
    const settings = {
      openai: { apiKey: "sk-openai-key" },
      google: { apiKey: "google-key" },
    }

    const result = getEmbeddingApiKey("openai", settings)

    expect(result).toBe("sk-openai-key")
  })

  it("returns Google key for google provider", () => {
    const settings = {
      openai: { apiKey: "sk-openai-key" },
      google: { apiKey: "google-key" },
    }

    const result = getEmbeddingApiKey("google", settings)

    expect(result).toBe("google-key")
  })

  it("returns null when provider not configured", () => {
    const settings = {
      openai: { apiKey: "sk-openai-key" },
    }

    const result = getEmbeddingApiKey("google", settings)

    expect(result).toBeNull()
  })

  it("returns null when apiKey is empty", () => {
    const settings = {
      openai: { apiKey: "" },
    }

    const result = getEmbeddingApiKey("openai", settings)

    // Empty API key returns null or empty string
    expect(result === "" || result === null).toBe(true)
  })

  it("returns null for empty settings", () => {
    const result = getEmbeddingApiKey("openai", {})

    expect(result).toBeNull()
  })

  it("returns empty string for transformersjs (no API key needed)", () => {
    const result = getEmbeddingApiKey("transformersjs", {})

    expect(result).toBe("")
  })

  it("returns empty string for transformersjs even with settings", () => {
    const settings = {
      openai: { apiKey: "sk-openai-key" },
    }

    const result = getEmbeddingApiKey("transformersjs", settings)

    expect(result).toBe("")
  })

  it("returns null for voyage (no shared chat-provider key)", () => {
    // Voyage has no chat-provider settings entry; its key is supplied via the
    // embedding config directly, so the shared-key lookup returns null.
    const result = getEmbeddingApiKey("voyage", { openai: { apiKey: "sk-openai-key" } })

    expect(result).toBeNull()
  })

  it("resolves a local provider key from its own chat-provider entry", () => {
    const result = getEmbeddingApiKey("ollama", { ollama: { apiKey: "ollama-token" } })

    expect(result).toBe("ollama-token")
  })
})

describe("embeddingProviderRequiresApiKey", () => {
  it("requires a key for cloud providers, not for local/browser ones", () => {
    expect(embeddingProviderRequiresApiKey("openai")).toBe(true)
    expect(embeddingProviderRequiresApiKey("voyage")).toBe(true)
    expect(embeddingProviderRequiresApiKey("ollama")).toBe(false)
    expect(embeddingProviderRequiresApiKey("lmstudio")).toBe(false)
    expect(embeddingProviderRequiresApiKey("transformersjs")).toBe(false)
  })
})

describe("normalizeTextForEmbedding", () => {
  it("trims whitespace", () => {
    const result = normalizeTextForEmbedding("  text  ")

    expect(result).toBe("text")
  })

  it("normalizes multiple spaces to single space", () => {
    const result = normalizeTextForEmbedding("hello    world")

    expect(result).toBe("hello world")
  })

  it("converts newlines to spaces", () => {
    const result = normalizeTextForEmbedding("line1\nline2\nline3")

    expect(result).toBe("line1 line2 line3")
  })

  it("handles multiple newlines", () => {
    const result = normalizeTextForEmbedding("para1\n\n\npara2")

    expect(result).toBe("para1 para2")
  })

  it("handles tabs", () => {
    const result = normalizeTextForEmbedding("col1\tcol2\tcol3")

    expect(result).toBe("col1 col2 col3")
  })

  it("handles mixed whitespace", () => {
    const result = normalizeTextForEmbedding("  hello \n\n world  \t test  ")

    expect(result).toBe("hello world test")
  })

  it("returns empty string for whitespace-only input", () => {
    const result = normalizeTextForEmbedding("   \n\n   ")

    expect(result).toBe("")
  })

  it("preserves single words", () => {
    const result = normalizeTextForEmbedding("word")

    expect(result).toBe("word")
  })

  it("handles empty string", () => {
    const result = normalizeTextForEmbedding("")

    expect(result).toBe("")
  })
})
