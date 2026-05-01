import {
  EmbeddingCache,
  createEmbeddingCache,
  getGlobalEmbeddingCache,
  resetGlobalEmbeddingCache,
} from "./embedding-cache"

describe("EmbeddingCache", () => {
  let cache: EmbeddingCache

  beforeEach(() => {
    cache = new EmbeddingCache({ maxEntries: 5, enabled: true })
  })

  describe("basic operations", () => {
    it("should cache and retrieve embeddings", () => {
      const embedding = [0.1, 0.2, 0.3]
      cache.set("hello world", embedding)
      expect(cache.get("hello world")).toEqual(embedding)
    })

    it("should return null for missing entries", () => {
      expect(cache.get("nonexistent")).toBeNull()
    })

    it("should check existence with has()", () => {
      cache.set("test", [1, 2, 3])
      expect(cache.has("test")).toBe(true)
      expect(cache.has("other")).toBe(false)
    })

    it("should delete entries", () => {
      cache.set("test", [1, 2, 3])
      expect(cache.has("test")).toBe(true)
      cache.delete("test")
      expect(cache.has("test")).toBe(false)
    })

    it("should clear all entries", () => {
      cache.set("a", [1])
      cache.set("b", [2])
      cache.set("c", [3])
      expect(cache.size()).toBe(3)
      cache.clear()
      expect(cache.size()).toBe(0)
    })
  })

  describe("LRU eviction", () => {
    it("should evict oldest entries when at capacity", () => {
      // Fill cache to capacity (5)
      cache.set("a", [1])
      cache.set("b", [2])
      cache.set("c", [3])
      cache.set("d", [4])
      cache.set("e", [5])
      expect(cache.size()).toBe(5)

      // Adding 6th should evict 'a'
      cache.set("f", [6])
      expect(cache.size()).toBe(5)
      expect(cache.get("a")).toBeNull() // evicted
      expect(cache.get("f")).toEqual([6]) // present
    })

    it("should promote accessed entries (LRU)", () => {
      cache.set("a", [1])
      cache.set("b", [2])
      cache.set("c", [3])
      cache.set("d", [4])
      cache.set("e", [5])

      // Access 'a' to promote it
      cache.get("a")

      // Add new entry — 'b' should be evicted (oldest not-accessed)
      cache.set("f", [6])
      expect(cache.get("a")).toEqual([1]) // promoted, still present
      expect(cache.get("b")).toBeNull() // evicted
    })
  })

  describe("disabled cache", () => {
    it("should return null when disabled", () => {
      const disabled = new EmbeddingCache({ enabled: false })
      disabled.set("test", [1, 2, 3])
      expect(disabled.get("test")).toBeNull()
      expect(disabled.has("test")).toBe(false)
    })

    it("should toggle enabled state", () => {
      cache.set("test", [1, 2, 3])
      expect(cache.isEnabled()).toBe(true)
      cache.setEnabled(false)
      expect(cache.get("test")).toBeNull()
      cache.setEnabled(true)
      // Entry still exists after re-enabling
      expect(cache.get("test")).toEqual([1, 2, 3])
    })
  })

  describe("stats tracking", () => {
    it("should track hits and misses", () => {
      cache.set("test", [1, 2, 3])
      cache.get("test") // hit
      cache.get("test") // hit
      cache.get("missing") // miss

      const stats = cache.getStats()
      expect(stats.hits).toBe(2)
      expect(stats.misses).toBe(1)
      expect(stats.hitRate).toBeCloseTo(2 / 3)
      expect(stats.size).toBe(1)
    })

    it("should track evictions", () => {
      for (let i = 0; i < 10; i++) {
        cache.set(`item-${i}`, [i])
      }
      const stats = cache.getStats()
      expect(stats.evictions).toBe(5) // 10 items, capacity 5
      expect(stats.size).toBe(5)
    })

    it("should reset stats on clear", () => {
      cache.set("test", [1])
      cache.get("test")
      cache.clear()
      const stats = cache.getStats()
      expect(stats.hits).toBe(0)
      expect(stats.misses).toBe(0)
      expect(stats.evictions).toBe(0)
    })
  })

  describe("createEmbeddingCache", () => {
    it("should create a cache instance", () => {
      const c = createEmbeddingCache({ maxEntries: 10 })
      expect(c).toBeInstanceOf(EmbeddingCache)
      c.set("test", [1])
      expect(c.get("test")).toEqual([1])
    })
  })

  describe("global singleton", () => {
    afterEach(() => {
      resetGlobalEmbeddingCache()
    })

    it("should return the same instance", () => {
      const a = getGlobalEmbeddingCache()
      const b = getGlobalEmbeddingCache()
      expect(a).toBe(b)
    })

    it("should reset the global cache", () => {
      const a = getGlobalEmbeddingCache()
      a.set("test", [1])
      resetGlobalEmbeddingCache()
      const b = getGlobalEmbeddingCache()
      expect(b).not.toBe(a)
      expect(b.get("test")).toBeNull()
    })
  })

  describe("content-based keying", () => {
    it("should treat identical content as the same key", () => {
      cache.set("same content", [1, 2, 3])
      cache.set("same content", [4, 5, 6]) // overwrite
      expect(cache.get("same content")).toEqual([4, 5, 6])
      expect(cache.size()).toBe(1)
    })

    it("should treat different content as different keys", () => {
      cache.set("content A", [1])
      cache.set("content B", [2])
      expect(cache.get("content A")).toEqual([1])
      expect(cache.get("content B")).toEqual([2])
      expect(cache.size()).toBe(2)
    })
  })
})
