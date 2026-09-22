import { TranscriptDetailCache } from "./detail-cache"

describe("TranscriptDetailCache", () => {
  it("pins an expanded detail atomically before applying the soft budget", () => {
    const cache = new TranscriptDetailCache<string>({ softBytes: 10, hardBytes: 20 })
    cache.set("s:t", "expanded", 15, "s", true)
    expect(cache.get("s:t")).toBe("expanded")
    expect(cache.stats()).toEqual({ entries: 1, bytes: 15, pinned: 1 })
    cache.unpin("s:t")
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0, pinned: 0 })
  })

  it("still enforces the hard budget when all details are expanded", () => {
    const cache = new TranscriptDetailCache<string>({ softBytes: 10, hardBytes: 20 })
    cache.set("s:a", "older", 15, "s", true)
    cache.set("s:b", "newer", 15, "s", true)
    expect(cache.get("s:a")).toBeUndefined()
    expect(cache.get("s:b")).toBe("newer")
    cache.set("s:oversized", "huge", 21, "s", true)
    expect(cache.stats().bytes).toBeLessThanOrEqual(20)
  })

  it("rejects invalid byte sizes and clears all bookkeeping", () => {
    const cache = new TranscriptDetailCache<string>()
    for (const bytes of [-1, NaN, Infinity, 0.5])
      expect(() => cache.set("s:t", "x", bytes)).toThrow()
    expect(cache.delete("missing")).toBe(false)
    cache.pin("missing")
    cache.unpin("missing")
    cache.set("s:t", "x", 1)
    cache.clear()
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0, pinned: 0 })
  })
  it("evicts least-recently-used unpinned details above the soft byte budget", () => {
    const cache = new TranscriptDetailCache<string>({ softBytes: 10, hardBytes: 20 })
    cache.set("s1:t1", "one", 6)
    cache.set("s1:t2", "two", 6)

    expect(cache.get("s1:t1")).toBeUndefined()
    expect(cache.get("s1:t2")).toBe("two")
    expect(cache.stats()).toEqual({ entries: 1, bytes: 6, pinned: 0 })
  })

  it("keeps pinned details until the hard budget is exceeded", () => {
    const cache = new TranscriptDetailCache<string>({ softBytes: 10, hardBytes: 15 })
    cache.set("s1:t1", "one", 8)
    cache.pin("s1:t1")
    cache.set("s1:t2", "two", 6)

    expect(cache.get("s1:t1")).toBe("one")
    expect(cache.get("s1:t2")).toBeUndefined()

    cache.set("s1:t3", "three", 9)
    expect(cache.stats().bytes).toBeLessThanOrEqual(15)
  })

  it("clears only entries owned by the requested session", () => {
    const cache = new TranscriptDetailCache<string>({ softBytes: 100, hardBytes: 200 })
    cache.set("s1:t1", "one", 1, "s1")
    cache.set("s2:t1", "two", 1, "s2")

    cache.clearSession("s1")

    expect(cache.get("s1:t1")).toBeUndefined()
    expect(cache.get("s2:t1")).toBe("two")
  })

  it("replaces an entry without double-counting its previous bytes", () => {
    const cache = new TranscriptDetailCache<string>({ softBytes: 100, hardBytes: 200 })
    cache.set("s1:t1", "one", 10)
    cache.set("s1:t1", "updated", 4)

    expect(cache.get("s1:t1")).toBe("updated")
    expect(cache.stats().bytes).toBe(4)
  })
})
