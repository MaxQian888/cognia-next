/**
 * Tests for RAG Query Cache
 */

// Jest globals are auto-imported
const vi = {
  fn: jest.fn,
  spyOn: jest.spyOn,
  useFakeTimers: jest.useFakeTimers,
  useRealTimers: jest.useRealTimers,
  advanceTimersByTime: (ms: number) => jest.advanceTimersByTime(ms),
}
import {
  LRUCache,
  RAGQueryCache,
  createRAGQueryCache,
  createHighPerformanceCache,
  createLightweightCache,
} from "./cache"
import type { RAGPipelineContext } from "./rag-pipeline"

describe("LRUCache", () => {
  let cache: LRUCache<string>

  beforeEach(() => {
    cache = new LRUCache<string>(5, 60000) // 5 items, 1 minute TTL
  })

  it("should store and retrieve items", () => {
    cache.set("key1", "value1", "collection1")
    expect(cache.get("key1")).toBe("value1")
  })

  it("should return null for missing keys", () => {
    expect(cache.get("missing")).toBeNull()
  })

  it("should evict oldest items when at capacity", () => {
    cache.set("key1", "value1", "collection1")
    cache.set("key2", "value2", "collection1")
    cache.set("key3", "value3", "collection1")
    cache.set("key4", "value4", "collection1")
    cache.set("key5", "value5", "collection1")
    cache.set("key6", "value6", "collection1") // Should evict key1

    expect(cache.get("key1")).toBeNull()
    expect(cache.get("key6")).toBe("value6")
  })

  it("should update LRU order on access", () => {
    cache.set("key1", "value1", "collection1")
    cache.set("key2", "value2", "collection1")
    cache.set("key3", "value3", "collection1")
    cache.set("key4", "value4", "collection1")
    cache.set("key5", "value5", "collection1")

    // Access key1 to make it recently used
    cache.get("key1")

    // Add new item, should evict key2 instead of key1
    cache.set("key6", "value6", "collection1")

    expect(cache.get("key1")).toBe("value1")
    expect(cache.get("key2")).toBeNull()
  })

  it("should expire items after TTL", () => {
    vi.useFakeTimers()

    cache.set("key1", "value1", "collection1")
    expect(cache.get("key1")).toBe("value1")

    // Advance time past TTL
    vi.advanceTimersByTime(61000)

    expect(cache.get("key1")).toBeNull()

    vi.useRealTimers()
  })

  it("should invalidate collection", () => {
    cache.set("key1", "value1", "collection1")
    cache.set("key2", "value2", "collection1")
    cache.set("key3", "value3", "collection2")

    const invalidated = cache.invalidateCollection("collection1")

    expect(invalidated).toBe(2)
    expect(cache.get("key1")).toBeNull()
    expect(cache.get("key2")).toBeNull()
    expect(cache.get("key3")).toBe("value3")
  })

  it("should clear expired entries", () => {
    vi.useFakeTimers()

    cache.set("key1", "value1", "collection1")
    vi.advanceTimersByTime(30000)
    cache.set("key2", "value2", "collection1")
    vi.advanceTimersByTime(35000) // key1 should be expired

    const cleared = cache.clearExpired()

    expect(cleared).toBe(1)
    expect(cache.get("key2")).toBe("value2")

    vi.useRealTimers()
  })

  it("should generate consistent cache keys", () => {
    const key1 = LRUCache.generateKey("Hello World", "collection")
    const key2 = LRUCache.generateKey("hello world", "collection")
    const key3 = LRUCache.generateKey("  Hello World  ", "collection")

    expect(key1).toBe(key2)
    expect(key1).toBe(key3)
  })

  it("should track statistics", () => {
    cache.set("key1", "value1", "collection1")

    cache.get("key1") // hit
    cache.get("missing") // miss
    cache.get("missing2") // miss

    const stats = cache.getStats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(2)
    expect(stats.hitRate).toBeCloseTo(0.333, 2)
  })

  it("should clear all entries", () => {
    cache.set("key1", "value1", "collection1")
    cache.set("key2", "value2", "collection1")

    cache.clear()

    expect(cache.size()).toBe(0)
    expect(cache.get("key1")).toBeNull()
  })

  it("should check if key exists", () => {
    cache.set("key1", "value1", "collection1")

    expect(cache.has("key1")).toBe(true)
    expect(cache.has("missing")).toBe(false)
  })
})

describe("RAGQueryCache", () => {
  let queryCache: RAGQueryCache

  const mockContext: RAGPipelineContext = {
    documents: [],
    query: "test query",
    formattedContext: "test context",
    totalTokensEstimate: 100,
    searchMetadata: {
      hybridSearchUsed: true,
      queryExpansionUsed: false,
      rerankingUsed: true,
      originalResultCount: 5,
      finalResultCount: 3,
    },
  }

  beforeEach(() => {
    queryCache = createRAGQueryCache({
      maxSize: 10,
      ttl: 60000,
      enabled: true,
      persistToIndexedDB: false,
    })
  })

  it("should cache and retrieve query results", async () => {
    await queryCache.set("test query", "collection1", mockContext)
    const result = await queryCache.get("test query", "collection1")

    expect(result).toEqual(mockContext)
  })

  it("should return null for missing queries", async () => {
    const result = await queryCache.get("missing query", "collection1")
    expect(result).toBeNull()
  })

  it("should return null when disabled", async () => {
    queryCache.setEnabled(false)

    await queryCache.set("test query", "collection1", mockContext)
    const result = await queryCache.get("test query", "collection1")

    expect(result).toBeNull()
  })

  it("should invalidate specific query", async () => {
    await queryCache.set("test query", "collection1", mockContext)

    const deleted = queryCache.invalidateQuery("test query", "collection1")

    expect(deleted).toBe(true)
    expect(await queryCache.get("test query", "collection1")).toBeNull()
  })

  it("should invalidate collection", async () => {
    await queryCache.set("query1", "collection1", mockContext)
    await queryCache.set("query2", "collection1", mockContext)
    await queryCache.set("query3", "collection2", mockContext)

    const count = queryCache.invalidateCollection("collection1")

    expect(count).toBe(2)
    expect(await queryCache.get("query1", "collection1")).toBeNull()
    expect(await queryCache.get("query3", "collection2")).toEqual(mockContext)
  })

  it("should clear all cache", async () => {
    await queryCache.set("query1", "collection1", mockContext)
    await queryCache.set("query2", "collection2", mockContext)

    await queryCache.clear()

    expect(await queryCache.get("query1", "collection1")).toBeNull()
    expect(await queryCache.get("query2", "collection2")).toBeNull()
  })

  it("should report statistics", async () => {
    await queryCache.set("query1", "collection1", mockContext)

    await queryCache.get("query1", "collection1") // hit
    await queryCache.get("missing", "collection1") // miss

    const stats = queryCache.getStats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)
    expect(stats.size).toBe(1)
  })
})

describe("Cache Factory Functions", () => {
  it("should create high performance cache", () => {
    const cache = createHighPerformanceCache()
    expect(cache).toBeInstanceOf(RAGQueryCache)
    expect(cache.isEnabled()).toBe(true)
  })

  it("should create lightweight cache", () => {
    const cache = createLightweightCache()
    expect(cache).toBeInstanceOf(RAGQueryCache)
    expect(cache.isEnabled()).toBe(true)
  })
})
