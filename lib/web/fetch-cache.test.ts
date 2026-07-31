import { FetchCache, fetchCacheKey, getFetchCache, resetFetchCache } from "./fetch-cache"

afterEach(() => resetFetchCache())

describe("fetchCacheKey", () => {
  it("is stable for the same inputs and defaults method/format", () => {
    expect(fetchCacheKey({ url: "https://a.test" })).toBe("GET|https://a.test|auto|||")
    expect(fetchCacheKey({ url: " https://a.test " })).toBe("GET|https://a.test|auto|||")
  })

  it("varies by method, format, cap, prompt and offset", () => {
    const base = fetchCacheKey({ url: "u" })
    expect(fetchCacheKey({ url: "u", method: "post" })).not.toBe(base)
    expect(fetchCacheKey({ url: "u", format: "raw" })).not.toBe(base)
    expect(fetchCacheKey({ url: "u", maxBytes: 100 })).not.toBe(base)
    expect(fetchCacheKey({ url: "u", prompt: "q" })).not.toBe(base)
    expect(fetchCacheKey({ url: "u", offset: 40 })).not.toBe(base)
  })
})

describe("FetchCache", () => {
  it("stores and retrieves values", () => {
    const cache = new FetchCache()
    expect(cache.get("k")).toBeNull()
    cache.set("k", { ok: true })
    expect(cache.get("k")).toEqual({ ok: true })
    expect(cache.size).toBe(1)
  })

  it("expires entries past the TTL", () => {
    let t = 1000
    const cache = new FetchCache({ ttl: 500, now: () => t })
    cache.set("k", "v")
    t = 1400
    expect(cache.get("k")).toBe("v")
    t = 1600
    expect(cache.get("k")).toBeNull()
  })

  it("evicts the least-recently-used entry past maxSize", () => {
    const cache = new FetchCache({ maxSize: 2 })
    cache.set("a", 1)
    cache.set("b", 2)
    // Touch "a" so "b" becomes the LRU.
    expect(cache.get("a")).toBe(1)
    cache.set("c", 3)
    expect(cache.get("b")).toBeNull()
    expect(cache.get("a")).toBe(1)
    expect(cache.get("c")).toBe(3)
  })

  it("stays bounded (no infinite eviction) when maxSize is 0", () => {
    // The eviction loop can't evict from an empty map, so it breaks out; the
    // entry is then stored once. Repeated sets evict-then-store, never growing.
    const cache = new FetchCache({ maxSize: 0 })
    cache.set("k", "v")
    cache.set("k2", "v2")
    expect(cache.size).toBeLessThanOrEqual(1)
  })

  it("clears all entries", () => {
    const cache = new FetchCache()
    cache.set("k", "v")
    cache.clear()
    expect(cache.size).toBe(0)
  })
})

describe("getFetchCache / resetFetchCache", () => {
  it("returns a shared singleton until reset", () => {
    const a = getFetchCache()
    a.set("k", "v")
    expect(getFetchCache().get("k")).toBe("v")
    resetFetchCache()
    expect(getFetchCache().get("k")).toBeNull()
  })
})
