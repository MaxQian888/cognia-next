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
