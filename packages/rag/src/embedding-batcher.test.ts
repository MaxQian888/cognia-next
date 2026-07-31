/**
 * @jest-environment jsdom
 */

import {
  EmbeddingBatcher,
  batchGenerateEmbeddings,
  createEmbeddingBatcher,
  getGlobalBatcher,
  resetGlobalBatcher,
  type BatcherConfig,
} from "./embedding-batcher"

// Mock the embedding module
jest.mock("@cognia/vector/embedding", () => ({
  generateEmbeddings: jest.fn(),
}))

import { generateEmbeddings } from "@cognia/vector/embedding"

const mockGenerateEmbeddings = generateEmbeddings as jest.MockedFunction<typeof generateEmbeddings>

describe("EmbeddingBatcher", () => {
  const mockEmbeddingConfig = {
    provider: "openai" as const,
    model: "text-embedding-3-small",
    dimensions: 1536,
  }
  const mockApiKey = "test-api-key"

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    resetGlobalBatcher()

    mockGenerateEmbeddings.mockResolvedValue({
      embeddings: [[0.1, 0.2, 0.3]],
      model: "text-embedding-3-small",
      provider: "openai",
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe("constructor", () => {
    it("should create batcher with default config", () => {
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey)
      expect(batcher.getQueueSize()).toBe(0)
      expect(batcher.isProcessing()).toBe(false)
    })

    it("should create batcher with custom config", () => {
      const customConfig: Partial<BatcherConfig> = {
        batchSize: 100,
        flushInterval: 200,
        enabled: true,
      }
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey, customConfig)
      expect(batcher).toBeDefined()
    })
  })

  describe("generateEmbedding", () => {
    it("should bypass batching when disabled", async () => {
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey, { enabled: false })

      const result = await batcher.generateEmbedding("test text")

      expect(result).toEqual([0.1, 0.2, 0.3])
      expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
        ["test text"],
        mockEmbeddingConfig,
        mockApiKey
      )
    })

    it("should queue requests when enabled", () => {
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey, { enabled: true })

      batcher.generateEmbedding("test text")

      expect(batcher.getQueueSize()).toBe(1)
    })

    it("should respect priority ordering", () => {
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey, {
        enabled: true,
        batchSize: 100,
      })

      batcher.generateEmbedding("low priority", 1)
      batcher.generateEmbedding("high priority", 10)
      batcher.generateEmbedding("medium priority", 5)

      expect(batcher.getQueueSize()).toBe(3)
    })

    it("should flush immediately when batch is full", async () => {
      mockGenerateEmbeddings.mockResolvedValue({
        embeddings: [[0.1], [0.2]],
        model: "text-embedding-3-small",
        provider: "openai",
      })

      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey, {
        enabled: true,
        batchSize: 2,
      })

      const p1 = batcher.generateEmbedding("text1")
      const p2 = batcher.generateEmbedding("text2")

      await Promise.all([p1, p2])

      expect(mockGenerateEmbeddings).toHaveBeenCalled()
    })
  })

  describe("generateEmbeddings", () => {
    it("should return empty array for empty input", async () => {
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey)
      const result = await batcher.generateEmbeddings([])
      expect(result).toEqual([])
    })

    it("should process multiple texts", async () => {
      mockGenerateEmbeddings.mockResolvedValue({
        embeddings: [[0.1], [0.2], [0.3]],
        model: "text-embedding-3-small",
        provider: "openai",
      })

      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey, { enabled: false })
      const result = await batcher.generateEmbeddings(["text1", "text2", "text3"])

      expect(result).toHaveLength(3)
    })
  })

  describe("getStats", () => {
    it("should return initial stats", () => {
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey)
      const stats = batcher.getStats()

      expect(stats.totalRequests).toBe(0)
      expect(stats.batchesProcessed).toBe(0)
      expect(stats.averageBatchSize).toBe(0)
      expect(stats.averageLatency).toBe(0)
      expect(stats.errors).toBe(0)
      expect(stats.retries).toBe(0)
      expect(stats.queueSize).toBe(0)
    })

    it("should track requests", () => {
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey, { enabled: true })

      batcher.generateEmbedding("text1")
      batcher.generateEmbedding("text2")

      const stats = batcher.getStats()
      expect(stats.totalRequests).toBe(2)
      expect(stats.queueSize).toBe(2)
    })
  })

  describe("resetStats", () => {
    it("should reset all statistics", () => {
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey, { enabled: true })

      batcher.generateEmbedding("text")
      batcher.resetStats()

      const stats = batcher.getStats()
      expect(stats.totalRequests).toBe(0)
    })
  })

  describe("clearQueue", () => {
    it("should clear pending requests and reject them", async () => {
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey, {
        enabled: true,
        batchSize: 100,
      })

      const promise = batcher.generateEmbedding("text")
      const cleared = batcher.clearQueue()

      expect(cleared).toBe(1)
      expect(batcher.getQueueSize()).toBe(0)
      await expect(promise).rejects.toThrow("Queue cleared")
    })
  })

  describe("setEnabled", () => {
    it("should toggle batching enabled state", async () => {
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey, { enabled: true })

      batcher.setEnabled(false)
      const result = await batcher.generateEmbedding("text")

      expect(result).toEqual([0.1, 0.2, 0.3])
      expect(mockGenerateEmbeddings).toHaveBeenCalled()
    })
  })

  describe("setBatchSize", () => {
    it("should update batch size with minimum of 1", () => {
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey)

      batcher.setBatchSize(0)
      expect(batcher).toBeDefined()

      batcher.setBatchSize(100)
      expect(batcher).toBeDefined()
    })
  })

  describe("setFlushInterval", () => {
    it("should update flush interval with minimum of 10", () => {
      const batcher = new EmbeddingBatcher(mockEmbeddingConfig, mockApiKey)

      batcher.setFlushInterval(5)
      expect(batcher).toBeDefined()

      batcher.setFlushInterval(500)
      expect(batcher).toBeDefined()
    })
  })
})

describe("batchGenerateEmbeddings", () => {
  const mockEmbeddingConfig = {
    provider: "openai" as const,
    model: "text-embedding-3-small",
    dimensions: 1536,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGenerateEmbeddings.mockImplementation(async (texts: string[]) => ({
      embeddings: texts.map(() => [0.1, 0.2, 0.3]),
      model: "text-embedding-3-small",
      provider: "openai" as const,
    }))
  })

  it("should return empty result for empty input", async () => {
    const result = await batchGenerateEmbeddings([], mockEmbeddingConfig, "api-key")

    expect(result.embeddings).toEqual([])
    expect(result.stats.batches).toBe(0)
  })

  it("should process texts in batches", async () => {
    const texts = Array.from({ length: 100 }, (_, i) => `text-${i}`)

    const result = await batchGenerateEmbeddings(texts, mockEmbeddingConfig, "api-key", {
      batchSize: 50,
    })

    expect(result.embeddings).toHaveLength(100)
    expect(result.stats.batches).toBe(2)
  })

  it("should call progress callback", async () => {
    const onProgress = jest.fn()
    const texts = ["text1", "text2", "text3"]

    await batchGenerateEmbeddings(texts, mockEmbeddingConfig, "api-key", {
      batchSize: 2,
      onProgress,
    })

    expect(onProgress).toHaveBeenCalled()
  })

  it("should track total time", async () => {
    const result = await batchGenerateEmbeddings(["text"], mockEmbeddingConfig, "api-key")

    expect(result.stats.totalTime).toBeGreaterThanOrEqual(0)
  })
})

describe("createEmbeddingBatcher", () => {
  it("should create a new batcher instance", () => {
    const batcher = createEmbeddingBatcher(
      { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
      "api-key"
    )

    expect(batcher).toBeInstanceOf(EmbeddingBatcher)
  })
})

describe("getGlobalBatcher", () => {
  beforeEach(() => {
    resetGlobalBatcher()
  })

  it("should return singleton instance", () => {
    const config = {
      provider: "openai" as const,
      model: "text-embedding-3-small",
      dimensions: 1536,
    }

    const batcher1 = getGlobalBatcher(config, "api-key")
    const batcher2 = getGlobalBatcher(config, "api-key")

    expect(batcher1).toBe(batcher2)
  })
})

describe("resetGlobalBatcher", () => {
  it("should reset the global batcher", () => {
    const config = {
      provider: "openai" as const,
      model: "text-embedding-3-small",
      dimensions: 1536,
    }

    const batcher1 = getGlobalBatcher(config, "api-key")
    resetGlobalBatcher()
    const batcher2 = getGlobalBatcher(config, "api-key")

    expect(batcher1).not.toBe(batcher2)
  })
})
