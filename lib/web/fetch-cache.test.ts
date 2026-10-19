import {
  fetchCacheKey,
  FetchCache,
  getFetchCache,
  READER_CACHE_CONTRACT_VERSION,
  representationSize,
  resetFetchCache,
} from "./fetch-cache"

describe("fetchCacheKey", () => {
  it("separates scope, reader revision, format, prompt and distillation", () => {
    const base = fetchCacheKey({ url: "https://a.example", scope: "s1" })
    expect(fetchCacheKey({ url: "https://a.example", scope: "s2" })).not.toBe(base)
    expect(fetchCacheKey({ url: "https://a.example", scope: "s1", readerRevision: "r2" })).not.toBe(
      base
    )
    expect(fetchCacheKey({ url: "https://a.example", scope: "s1", format: "text" })).not.toBe(base)
    expect(fetchCacheKey({ url: "https://a.example", scope: "s1", prompt: "who" })).not.toBe(base)
    expect(
      fetchCacheKey({ url: "https://a.example", scope: "s1", distillation: "required" })
    ).not.toBe(base)
  })

  it("carries the contract version so older entries can never be hit", () => {
    expect(fetchCacheKey({ url: "u" }).startsWith(`v${READER_CACHE_CONTRACT_VERSION}`)).toBe(true)
  })

  it("trims the URL and prompt", () => {
    expect(fetchCacheKey({ url: " u ", prompt: " p " })).toBe(
      fetchCacheKey({ url: "u", prompt: "p" })
    )
  })
})

describe("representationSize", () => {
  it("counts the characters of nested strings only", () => {
    expect(representationSize({ text: "abcd", title: "xy", status: 200, list: ["z"] })).toBe(7)
  })
})

describe("FetchCache", () => {
  it("expires entries after the TTL", () => {
    let now = 0
    const cache = new FetchCache({ ttl: 1000, now: () => now })
    cache.set("k", { text: "v" })
    now = 999
    expect(cache.get("k")).toEqual({ text: "v" })
    now = 2001
    expect(cache.get("k")).toBeNull()
    expect(cache.size).toBe(0)
  })

  it("evicts the least recently used entry at the entry bound", () => {
    const cache = new FetchCache({ maxSize: 2 })
    cache.set("a", "1")
    cache.set("b", "2")
    cache.get("a")
    cache.set("c", "3")
    expect(cache.get("b")).toBeNull()
    expect(cache.get("a")).toBe("1")
  })

  it("refuses an oversized representation and reports it", () => {
    const cache = new FetchCache({ maxEntryChars: 10 })
    expect(cache.set("big", "x".repeat(11))).toBe(false)
    expect(cache.get("big")).toBeNull()
  })

  it("evicts by aggregate character budget", () => {
    const cache = new FetchCache({ maxEntryChars: 10, maxTotalChars: 15 })
    cache.set("a", "x".repeat(10))
    cache.set("b", "x".repeat(10))
    expect(cache.get("a")).toBeNull()
    expect(cache.characters).toBe(10)
  })

  it("clears one scope without touching another", () => {
    const cache = new FetchCache()
    cache.set(fetchCacheKey({ url: "u", scope: "a" }), "1")
    cache.set(fetchCacheKey({ url: "u", scope: "b" }), "2")
    cache.clearScope("a")
    expect(cache.get(fetchCacheKey({ url: "u", scope: "a" }))).toBeNull()
    expect(cache.get(fetchCacheKey({ url: "u", scope: "b" }))).toBe("2")
  })

  it("keeps the character tally consistent when overwriting a key", () => {
    const cache = new FetchCache()
    cache.set("k", "abc")
    cache.set("k", "abcdef")
    expect(cache.characters).toBe(6)
    cache.clear()
    expect(cache.characters).toBe(0)
  })
})

describe("shared cache", () => {
  it("is a singleton until reset", () => {
    const first = getFetchCache()
    expect(getFetchCache()).toBe(first)
    resetFetchCache()
    expect(getFetchCache()).not.toBe(first)
  })
})
