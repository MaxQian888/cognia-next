import { SnapshotCache, snapshotCacheKey } from "./snapshot-cache"
import type { BrowserSnapshot } from "./protocol"

const snap = (generation: number): BrowserSnapshot => ({
  generation,
  url: "https://a/b",
  title: "t",
  nodes: [],
})

describe("SnapshotCache (ADR-0127)", () => {
  it("starts dirty, serves the stored snapshot until invalidated", () => {
    const cache = new SnapshotCache()
    expect(cache.get()).toBeNull()
    cache.set(snap(1))
    expect(cache.get()).toEqual(snap(1))
    expect(cache.get()).toEqual(snap(1))
    cache.markDirty()
    expect(cache.get()).toBeNull()
    expect(cache.getStats()).toEqual({ hits: 2, misses: 2, invalidations: 1 })
  })

  it("keys on includeText and honours the fresh escape hatch", () => {
    const cache = new SnapshotCache()
    cache.set(snap(1), { includeText: true })
    expect(cache.get({ includeText: true })).toEqual(snap(1))
    expect(cache.get()).toBeNull()
    expect(cache.get({ includeText: true, fresh: true })).toBeNull()
    expect(snapshotCacheKey({ includeText: true })).toBe("text")
    expect(snapshotCacheKey()).toBe("plain")
  })

  it("markDirty is idempotent for the invalidation counter and clear forgets", () => {
    const cache = new SnapshotCache()
    cache.set(snap(3))
    cache.markDirty()
    cache.markDirty()
    expect(cache.getStats().invalidations).toBe(1)
    expect(cache.isDirty()).toBe(true)
    cache.set(snap(4))
    expect(cache.isDirty()).toBe(false)
    cache.clear()
    expect(cache.get()).toBeNull()
    expect(cache.isDirty()).toBe(true)
  })
})
