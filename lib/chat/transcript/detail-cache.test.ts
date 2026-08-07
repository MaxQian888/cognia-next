import { TranscriptDetailCache } from "./detail-cache"

describe("TranscriptDetailCache", () => {
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
