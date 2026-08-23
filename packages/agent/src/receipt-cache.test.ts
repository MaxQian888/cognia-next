import { ReceiptCache } from "./receipt-cache"

function clock(start = 1_000) {
  let value = start
  return {
    now: () => value,
    advance(ms: number) {
      value += ms
    },
  }
}

describe("ReceiptCache", () => {
  it("returns the memoised value for a duplicate invocation", () => {
    const cache = new ReceiptCache<string>({ maxEntries: 8, ttlMs: 1_000 })
    const factory = jest.fn(() => "first")
    expect(cache.remember("k", factory)).toBe("first")
    expect(cache.remember("k", () => "second")).toBe("first")
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("evicts the oldest entry once the ceiling is reached", () => {
    const cache = new ReceiptCache<number>({ maxEntries: 2, ttlMs: 60_000 })
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("c", 3)
    expect(cache.size).toBe(2)
    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("b")).toBe(2)
    expect(cache.get("c")).toBe(3)
  })

  it("treats an entry past its TTL as absent", () => {
    const time = clock()
    const cache = new ReceiptCache<string>({ maxEntries: 8, ttlMs: 500, now: time.now })
    cache.set("k", "v")
    time.advance(499)
    expect(cache.get("k")).toBe("v")
    time.advance(1)
    expect(cache.get("k")).toBeUndefined()
  })

  it("re-runs the factory once the memo has expired", () => {
    const time = clock()
    const cache = new ReceiptCache<string>({ maxEntries: 8, ttlMs: 100, now: time.now })
    expect(cache.remember("k", () => "first")).toBe("first")
    time.advance(101)
    expect(cache.remember("k", () => "second")).toBe("second")
  })

  it("sweeps expired entries on write so the map cannot grow unbounded in time", () => {
    const time = clock()
    const cache = new ReceiptCache<number>({ maxEntries: 1_000, ttlMs: 100, now: time.now })
    for (let index = 0; index < 50; index += 1) cache.set(`k${index}`, index)
    expect(cache.size).toBe(50)
    time.advance(101)
    cache.set("fresh", 1)
    expect(cache.size).toBe(1)
  })

  it("keeps an entry alive for its full TTL even when read repeatedly", () => {
    const time = clock()
    const cache = new ReceiptCache<string>({ maxEntries: 8, ttlMs: 100, now: time.now })
    cache.set("k", "v")
    time.advance(60)
    expect(cache.get("k")).toBe("v")
    time.advance(60)
    // Reading does not refresh: total age is 120ms against a 100ms TTL.
    expect(cache.get("k")).toBeUndefined()
  })

  it("drops a single entry and clears everything on demand", () => {
    const cache = new ReceiptCache<number>({ maxEntries: 8, ttlMs: 1_000 })
    cache.set("a", 1)
    cache.set("b", 2)
    cache.delete("a")
    expect(cache.get("a")).toBeUndefined()
    cache.clear()
    expect(cache.size).toBe(0)
  })
})
