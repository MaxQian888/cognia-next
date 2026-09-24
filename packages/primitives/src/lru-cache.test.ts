import { LruCache } from "./lru-cache"

describe("LruCache", () => {
  it("stores and retrieves values", () => {
    const cache = new LruCache<number>(3)
    cache.set("a", 1)
    cache.set("b", 2)
    expect(cache.get("a")).toBe(1)
    expect(cache.get("b")).toBe(2)
    expect(cache.get("missing")).toBeUndefined()
  })

  it("reports membership and size", () => {
    const cache = new LruCache<string>(3)
    expect(cache.has("x")).toBe(false)
    expect(cache.size).toBe(0)
    cache.set("x", "v")
    expect(cache.has("x")).toBe(true)
    expect(cache.size).toBe(1)
  })

  it("evicts the least-recently-used entry past maxSize", () => {
    const cache = new LruCache<number>(2)
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("c", 3) // evicts "a" (oldest)
    expect(cache.has("a")).toBe(false)
    expect(cache.get("b")).toBe(2)
    expect(cache.get("c")).toBe(3)
    expect(cache.size).toBe(2)
  })

  it("get() refreshes recency so the touched key survives eviction", () => {
    const cache = new LruCache<number>(2)
    cache.set("a", 1)
    cache.set("b", 2)
    expect(cache.get("a")).toBe(1) // "a" is now most-recent
    cache.set("c", 3) // evicts "b" (now the oldest), not "a"
    expect(cache.has("a")).toBe(true)
    expect(cache.has("b")).toBe(false)
    expect(cache.has("c")).toBe(true)
  })

  it("does not refresh an explicitly stored undefined value", () => {
    const cache = new LruCache<number | undefined>(2)
    cache.set("missing-value", undefined)
    cache.set("value", 1)
    expect(cache.has("missing-value")).toBe(true)
    expect(cache.get("missing-value")).toBeUndefined()
    cache.set("new-value", 2)
    expect(cache.has("missing-value")).toBe(false)
    expect(cache.get("value")).toBe(1)
  })

  it("set() on an existing key refreshes its value and recency", () => {
    const cache = new LruCache<number>(2)
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("a", 10) // updates value + moves "a" to most-recent
    expect(cache.get("a")).toBe(10)
    cache.set("c", 3) // evicts "b"
    expect(cache.has("a")).toBe(true)
    expect(cache.has("b")).toBe(false)
  })

  it("delete() removes a key", () => {
    const cache = new LruCache<number>(3)
    cache.set("a", 1)
    expect(cache.delete("a")).toBe(true)
    expect(cache.delete("a")).toBe(false)
    expect(cache.has("a")).toBe(false)
  })

  it("clear() empties the cache", () => {
    const cache = new LruCache<number>(3)
    cache.set("a", 1)
    cache.set("b", 2)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get("a")).toBeUndefined()
  })

  it("clamps a non-positive maxSize to 1 (stays a real cache)", () => {
    const cache = new LruCache<number>(0)
    cache.set("a", 1)
    expect(cache.get("a")).toBe(1)
    cache.set("b", 2) // evicts "a"
    expect(cache.has("a")).toBe(false)
    expect(cache.get("b")).toBe(2)
    expect(cache.size).toBe(1)
  })
})

describe("LruCache weight budget", () => {
  const makeCache = (maxSize = 10) =>
    new LruCache<string>(maxSize, {
      maxWeight: 10,
      weigh: (value, key) => value.length + key.length,
    })

  it("evicts as many least-recent entries as the weighted budget requires", () => {
    const cache = makeCache()
    cache.set("a", "12")
    cache.set("b", "12")
    cache.set("c", "12")
    cache.get("a")
    cache.set("d", "12345")
    expect(cache.has("b")).toBe(false)
    expect(cache.has("c")).toBe(false)
    expect(cache.get("a")).toBe("12")
    expect(cache.get("d")).toBe("12345")
    expect(cache.weight).toBe(9)
  })

  it("still enforces the entry count limit", () => {
    const cache = makeCache(2)
    cache.set("a", "1")
    cache.set("b", "1")
    cache.set("c", "1")
    expect(cache.has("a")).toBe(false)
    expect(cache.size).toBe(2)
    expect(cache.weight).toBe(4)
  })

  it("accounts for replacement, deletion and clearing", () => {
    const cache = makeCache()
    cache.set("a", "123")
    cache.set("a", "1")
    expect(cache.weight).toBe(2)
    expect(cache.delete("a")).toBe(true)
    expect(cache.delete("a")).toBe(false)
    expect(cache.weight).toBe(0)
    cache.set("b", "123")
    cache.clear()
    expect(cache.weight).toBe(0)
    expect(cache.size).toBe(0)
    cache.set("c", "123456789")
    expect(cache.weight).toBe(10)
  })

  it("skips an oversized replacement without retaining stale data or evicting unrelated entries", () => {
    const cache = makeCache()
    cache.set("a", "12")
    cache.set("b", "123")
    cache.set("b", "1234567890")
    cache.set("c", "1234567890")
    expect(cache.has("b")).toBe(false)
    expect(cache.has("c")).toBe(false)
    expect(cache.get("a")).toBe("12")
    expect(cache.weight).toBe(3)
  })

  it("supports an empty budget with zero-weight entries", () => {
    const cache = new LruCache<number>(2, { maxWeight: 0, weigh: (value) => value })
    cache.set("a", 0)
    cache.set("b", 1)
    expect(cache.get("a")).toBe(0)
    expect(cache.has("b")).toBe(false)
    expect(cache.weight).toBe(0)
  })

  it.each([-1, Infinity, NaN])("rejects an invalid weight budget (%s)", (maxWeight) => {
    expect(() => new LruCache(2, { maxWeight, weigh: () => 0 })).toThrow(RangeError)
  })

  it.each([-1, Infinity, NaN])(
    "rejects an invalid entry weight without changing the cache (%s)",
    (weight) => {
      const cache = new LruCache<number>(2, { maxWeight: 10, weigh: (value) => value })
      cache.set("a", 1)
      expect(() => cache.set("a", weight)).toThrow(RangeError)
      expect(cache.get("a")).toBe(1)
      expect(cache.weight).toBe(1)
    }
  )
})
