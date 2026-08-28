import {
  generateSearchCacheKey,
  SearchCache,
  getSearchCache,
  resetSearchCache,
} from "./search-cache"
import type { SearchResponse, SearchOptions } from "./types"

function makeResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    provider: "tavily",
    query: "anything",
    results: [],
    responseTime: 1,
    ...overrides,
  }
}

describe("generateSearchCacheKey", () => {
  it("normalizes query to lowercase and trim", () => {
    const k1 = generateSearchCacheKey("  Hello World ")
    const k2 = generateSearchCacheKey("hello world")
    expect(k1).toBe(k2)
  })

  it("differs by provider", () => {
    expect(generateSearchCacheKey("q", "tavily")).not.toBe(
      generateSearchCacheKey("q", "perplexity")
    )
  })

  it("differs by options", () => {
    const a = generateSearchCacheKey("q", "tavily", { maxResults: 5 })
    const b = generateSearchCacheKey("q", "tavily", { maxResults: 10 })
    expect(a).not.toBe(b)
  })

  it("treats sorted include/exclude domains the same", () => {
    const a = generateSearchCacheKey("q", "tavily", {
      includeDomains: ["b.com", "a.com"],
      excludeDomains: ["d.com", "c.com"],
    })
    const b = generateSearchCacheKey("q", "tavily", {
      includeDomains: ["a.com", "b.com"],
      excludeDomains: ["c.com", "d.com"],
    })
    expect(a).toBe(b)
  })

  it("encodes includeAnswer and includeRawContent", () => {
    const k1 = generateSearchCacheKey("q", "tavily", { includeAnswer: true })
    const k2 = generateSearchCacheKey("q", "tavily", { includeAnswer: false })
    expect(k1).not.toBe(k2)

    const r1 = generateSearchCacheKey("q", "tavily", { includeRawContent: true })
    const r2 = generateSearchCacheKey("q", "tavily", { includeRawContent: "markdown" })
    const r3 = generateSearchCacheKey("q", "tavily", { includeRawContent: false })
    expect(r1).not.toBe(r2)
    expect(r1).not.toBe(r3)
  })

  it("differs by safe-search level", () => {
    const off = generateSearchCacheKey("q", "tavily", { safeSearch: "off" })
    const strict = generateSearchCacheKey("q", "tavily", { safeSearch: "strict" })
    expect(off).not.toBe(strict)
  })

  it("includes ordered preferred providers in the policy key", () => {
    const first = generateSearchCacheKey("q", undefined, {
      preferredProviders: ["exa", "tavily"],
    })
    const second = generateSearchCacheKey("q", undefined, {
      preferredProviders: ["tavily", "exa"],
    })
    expect(first).not.toBe(second)
  })

  it("starts with 'search:'", () => {
    expect(generateSearchCacheKey("q")).toMatch(/^search:/)
  })
})

describe("SearchCache", () => {
  let warnSpy: jest.SpyInstance
  let debugSpy: jest.SpyInstance
  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    debugSpy.mockRestore()
  })

  it("returns null for missing key (counts as miss)", () => {
    const cache = new SearchCache()
    expect(cache.get("anything")).toBeNull()
    expect(cache.getStats().misses).toBe(1)
    expect(cache.getStats().hits).toBe(0)
  })

  it("set + get with same params returns cached response", () => {
    const cache = new SearchCache()
    const resp = makeResponse({ query: "q" })
    cache.set("q", resp)
    const got = cache.get("q")
    expect(got).toBe(resp)
    expect(cache.getStats().hits).toBe(1)
  })

  it("expires entries past TTL", () => {
    jest.useFakeTimers()
    try {
      const cache = new SearchCache({ defaultTTL: 1000 })
      cache.set("q", makeResponse())
      expect(cache.get("q")).not.toBeNull()
      jest.advanceTimersByTime(1500)
      expect(cache.get("q")).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it("uses newsTTL for news searches", () => {
    jest.useFakeTimers()
    try {
      const cache = new SearchCache({ defaultTTL: 1000, newsTTL: 200 })
      const opts: SearchOptions = { searchType: "news" }
      cache.set("q", makeResponse(), "tavily", opts)
      jest.advanceTimersByTime(300)
      expect(cache.get("q", "tavily", opts)).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it("evicts oldest entry when over maxSize", () => {
    const cache = new SearchCache({ maxSize: 2 })
    cache.set("a", makeResponse({ query: "a" }))
    cache.set("b", makeResponse({ query: "b" }))
    cache.set("c", makeResponse({ query: "c" }))
    expect(cache.has("a")).toBe(false)
    expect(cache.has("b")).toBe(true)
    expect(cache.has("c")).toBe(true)
  })

  it("get on a hit moves entry to MRU position", () => {
    const cache = new SearchCache({ maxSize: 2 })
    cache.set("a", makeResponse({ query: "a" }))
    cache.set("b", makeResponse({ query: "b" }))
    cache.get("a")
    cache.set("c", makeResponse({ query: "c" }))
    expect(cache.has("a")).toBe(true)
    expect(cache.has("b")).toBe(false)
  })

  it("invalidate without pattern clears everything", () => {
    const cache = new SearchCache()
    cache.set("a", makeResponse({ query: "a" }))
    cache.set("b", makeResponse({ query: "b" }))
    expect(cache.invalidate()).toBe(2)
    expect(cache.has("a")).toBe(false)
  })

  it("invalidate with pattern only removes matches", () => {
    const cache = new SearchCache()
    cache.set("hello", makeResponse({ query: "hello" }))
    cache.set("world", makeResponse({ query: "world" }))
    const matchingKey = (cache as unknown as { cache: Map<string, unknown> }).cache.keys().next()
      .value as string
    expect(matchingKey).toMatch(/^search:/)
    cache.invalidate(matchingKey)
    expect(cache.getStats().size).toBe(1)
  })

  it("invalidateProvider removes entries produced by that provider", () => {
    const cache = new SearchCache()
    cache.set("a", makeResponse({ provider: "tavily", query: "a" }))
    cache.set("b", makeResponse({ provider: "exa", query: "b" }))
    cache.set("c", makeResponse({ provider: "tavily", query: "c" }))

    expect(cache.invalidateProvider("tavily")).toBe(2)
    expect(cache.has("a")).toBe(false)
    expect(cache.has("b")).toBe(true)
    expect(cache.has("c")).toBe(false)
  })

  it("has() returns false for expired entries and cleans them up", () => {
    jest.useFakeTimers()
    try {
      const cache = new SearchCache({ defaultTTL: 1000 })
      cache.set("q", makeResponse())
      expect(cache.has("q")).toBe(true)
      jest.advanceTimersByTime(2000)
      expect(cache.has("q")).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it("setConfig updates maxSize and defaultTTL", () => {
    const cache = new SearchCache()
    cache.setConfig({ maxSize: 5, defaultTTL: 1234 })
    expect(cache.getStats().maxSize).toBe(5)
    cache.setConfig({})
    cache.setConfig({ maxSize: 0, defaultTTL: 0 })
    expect(cache.getStats().maxSize).toBe(5)
  })

  it("resetStats zeroes hits/misses without dropping cache", () => {
    const cache = new SearchCache()
    cache.set("q", makeResponse())
    cache.get("q")
    cache.get("missing")
    expect(cache.getStats().hits).toBe(1)
    expect(cache.getStats().misses).toBe(1)
    cache.resetStats()
    expect(cache.getStats().hits).toBe(0)
    expect(cache.getStats().misses).toBe(0)
    expect(cache.has("q")).toBe(true)
  })

  it("clear removes all entries", () => {
    const cache = new SearchCache()
    cache.set("q", makeResponse())
    cache.clear()
    expect(cache.has("q")).toBe(false)
  })

  it("cleanup removes expired entries", () => {
    jest.useFakeTimers()
    try {
      const cache = new SearchCache({ defaultTTL: 1000 })
      cache.set("a", makeResponse({ query: "a" }))
      cache.set("b", makeResponse({ query: "b" }))
      jest.advanceTimersByTime(1500)
      cache.set("c", makeResponse({ query: "c" }))
      const removed = cache.cleanup()
      expect(removed).toBe(2)
      expect(cache.has("c")).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it("hitRate is 0 when nothing happened", () => {
    const cache = new SearchCache()
    expect(cache.getStats().hitRate).toBe(0)
  })

  it("hitRate computes correctly", () => {
    const cache = new SearchCache()
    cache.set("q", makeResponse())
    cache.get("q")
    cache.get("missing")
    expect(cache.getStats().hitRate).toBeCloseTo(0.5)
  })
})

describe("getSearchCache singleton", () => {
  beforeEach(() => resetSearchCache())
  afterEach(() => resetSearchCache())

  it("returns the same instance across calls", () => {
    const a = getSearchCache()
    const b = getSearchCache()
    expect(a).toBe(b)
  })

  it("resetSearchCache clears the singleton", () => {
    const a = getSearchCache()
    resetSearchCache()
    const b = getSearchCache()
    expect(a).not.toBe(b)
  })
})
