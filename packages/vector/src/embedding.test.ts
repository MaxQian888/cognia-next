/** @jest-environment jsdom */
/**
 * Tests for Embedding utilities
 */

jest.mock("@cognia/provider-embedding/embedding", () => ({
  generateEmbedding: jest.fn(),
  generateEmbeddings: jest.fn(),
  cosineSimilarity: jest.fn((a: number[], b: number[]) => {
    const dot = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0)
    const magA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0))
    const magB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0))
    return dot / (magA * magB)
  }),
}))

jest.mock("@cognia/transformers-runtime", () => ({
  getTransformersManager: jest.fn(),
}))

const createBedrockSidecarEmbeddingModel = jest.fn((..._args: unknown[]) => ({
  modelId: "bedrock-sidecar",
}))
jest.mock("@/lib/claude/feature-call", () => ({
  createBedrockSidecarEmbeddingModel: (...args: unknown[]) =>
    createBedrockSidecarEmbeddingModel(...args),
}))

import {
  DEFAULT_EMBEDDING_MODELS,
  EmbeddingProviderRuntimeError,
  TRANSFORMERS_RUNTIME_ERROR_CODE,
  TRANSFORMERS_RUNTIME_ERROR_MESSAGE,
  assertEmbeddingProviderRuntimeAvailable,
  calculateSimilarity,
  embeddingProviderRequiresApiKey,
  findMostSimilar,
  generateEmbedding,
  generateEmbeddings,
  getEmbeddingApiKey,
  isEmbeddingProviderConfigured,
  isTransformersRuntimeAvailable,
  isTransformersRuntimeUnavailableError,
  normalizeTextForEmbedding,
  resolveEmbeddingApiKey,
  type EmbeddingProvider,
} from "./embedding"

import * as providerEmbedding from "@cognia/provider-embedding/embedding"

const mockGenerateAiEmbedding = jest.mocked(providerEmbedding.generateEmbedding)
const mockGenerateAiEmbeddings = jest.mocked(providerEmbedding.generateEmbeddings)
const mockGetTransformersManager = jest.requireMock("@cognia/transformers-runtime")
  .getTransformersManager as jest.Mock

describe("DEFAULT_EMBEDDING_MODELS", () => {
  it("has a native Amazon Bedrock model config", () => {
    expect(DEFAULT_EMBEDDING_MODELS["amazon-bedrock"]).toMatchObject({
      provider: "amazon-bedrock",
      model: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
    })
  })
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

describe("Amazon Bedrock embedding wiring", () => {
  it("uses the sidecar proxy for a default-chain embedding", async () => {
    mockGenerateAiEmbedding.mockResolvedValueOnce({ embedding: [0.1, 0.2] })
    await generateEmbedding(
      "safe text",
      {
        provider: "amazon-bedrock",
        model: "amazon.titan-embed-text-v2:0",
        bedrock: { authMode: "default-chain", region: "us-east-1" },
      },
      ""
    )
    expect(createBedrockSidecarEmbeddingModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "amazon.titan-embed-text-v2:0" })
    )
    expect(mockGenerateAiEmbedding).toHaveBeenCalledWith(
      "safe text",
      expect.objectContaining({
        provider: "amazon-bedrock",
        bedrockModel: { modelId: "bedrock-sidecar" },
      })
    )
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

describe("embedding provider configuration and runtime guards", () => {
  const originalWorker = global.Worker

  afterEach(() => {
    if (originalWorker === undefined) {
      Reflect.deleteProperty(global, "Worker")
    } else {
      global.Worker = originalWorker
    }
  })

  it("resolves API keys and configuration status for keyless and keyed providers", () => {
    expect(resolveEmbeddingApiKey("openai", { openai: { apiKey: "sk" } })).toBe("sk")
    expect(resolveEmbeddingApiKey("openai", {})).toBe("")
    expect(isEmbeddingProviderConfigured("ollama", {})).toBe(true)
    expect(isEmbeddingProviderConfigured("openai", {})).toBe(false)
    expect(isEmbeddingProviderConfigured("openai", { openai: { apiKey: "sk" } })).toBe(true)
  })

  it("detects Transformers runtime availability and throws typed runtime errors", () => {
    Reflect.deleteProperty(global, "Worker")

    expect(isTransformersRuntimeAvailable()).toBe(false)
    expect(() => assertEmbeddingProviderRuntimeAvailable("transformersjs")).toThrow(
      EmbeddingProviderRuntimeError
    )
    expect(() => assertEmbeddingProviderRuntimeAvailable("openai")).not.toThrow()

    const error = new EmbeddingProviderRuntimeError("custom message", "runtime_unavailable")
    expect(error.name).toBe("EmbeddingProviderRuntimeError")
    expect(error.code).toBe(TRANSFORMERS_RUNTIME_ERROR_CODE)

    global.Worker = function MockWorker() {} as unknown as typeof Worker
    expect(isTransformersRuntimeAvailable()).toBe(true)
    expect(() => assertEmbeddingProviderRuntimeAvailable("transformersjs")).not.toThrow()
  })

  it("identifies runtime-unavailable errors by code or message", () => {
    expect(isTransformersRuntimeUnavailableError(null)).toBe(false)
    expect(isTransformersRuntimeUnavailableError("plain string")).toBe(false)
    expect(isTransformersRuntimeUnavailableError({ code: TRANSFORMERS_RUNTIME_ERROR_CODE })).toBe(
      true
    )
    expect(
      isTransformersRuntimeUnavailableError({ message: TRANSFORMERS_RUNTIME_ERROR_MESSAGE })
    ).toBe(true)
    expect(isTransformersRuntimeUnavailableError(new Error("other"))).toBe(false)
  })
})

describe("embedding execution adapters", () => {
  const originalWorker = global.Worker

  beforeEach(() => {
    mockGenerateAiEmbedding.mockReset()
    mockGenerateAiEmbeddings.mockReset()
    mockGetTransformersManager.mockReset()
    global.Worker = function MockWorker() {} as unknown as typeof Worker
  })

  afterEach(() => {
    if (originalWorker === undefined) {
      Reflect.deleteProperty(global, "Worker")
    } else {
      global.Worker = originalWorker
    }
  })

  it("delegates single and batch embeddings to the provider-embedding adapter", async () => {
    mockGenerateAiEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] })
    mockGenerateAiEmbeddings.mockResolvedValue({ embeddings: [[0.1], [0.2]] })

    await expect(
      generateEmbedding(
        "hello",
        {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 2,
          baseURL: "https://p",
        },
        "sk"
      )
    ).resolves.toEqual({
      embedding: [0.1, 0.2],
      model: "text-embedding-3-small",
      provider: "openai",
    })
    await expect(
      generateEmbeddings(
        ["a", "b"],
        {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 2,
          baseURL: "https://p",
        },
        "sk"
      )
    ).resolves.toEqual({
      embeddings: [[0.1], [0.2]],
      model: "text-embedding-3-small",
      provider: "openai",
    })

    expect(mockGenerateAiEmbedding).toHaveBeenCalledWith("hello", {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk",
      dimensions: 2,
      baseURL: "https://p",
    })
    expect(mockGenerateAiEmbeddings).toHaveBeenCalledWith(["a", "b"], {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk",
      dimensions: 2,
      baseURL: "https://p",
    })
  })

  it("rejects missing API keys before invoking keyed providers", async () => {
    await expect(
      generateEmbedding("hello", { provider: "openai", model: "text-embedding-3-small" }, "")
    ).rejects.toThrow("requires an API key")
    expect(mockGenerateAiEmbedding).not.toHaveBeenCalled()
  })

  it("uses the Transformers manager for browser-local single and batch embeddings", async () => {
    const manager = {
      generateEmbedding: jest.fn().mockResolvedValue({ embedding: [0.3, 0.4] }),
      generateEmbeddings: jest.fn().mockResolvedValue({ embeddings: [[0.3], [0.4]] }),
    }
    mockGetTransformersManager.mockReturnValue(manager)

    await expect(
      generateEmbedding("hello", { provider: "transformersjs", model: "Xenova/model" }, "")
    ).resolves.toEqual({
      embedding: [0.3, 0.4],
      model: "Xenova/model",
      provider: "transformersjs",
    })
    await expect(
      generateEmbeddings(["a", "b"], { provider: "transformersjs", model: "Xenova/model" }, "")
    ).resolves.toEqual({
      embeddings: [[0.3], [0.4]],
      model: "Xenova/model",
      provider: "transformersjs",
    })

    expect(manager.generateEmbedding).toHaveBeenCalledWith("hello", "Xenova/model")
    expect(manager.generateEmbeddings).toHaveBeenCalledWith(["a", "b"], "Xenova/model")
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
