import {
  __resetGlobalSearchCachesForTesting,
  createSearchCache,
  invalidateGlobalSearchCaches,
} from "./cache"

describe("createSearchCache", () => {
  afterEach(() => __resetGlobalSearchCachesForTesting())

  it("loads once within the ttl and shares in-flight loads", async () => {
    let clock = 0
    const loader = jest.fn(async () => ["a"])
    const cache = createSearchCache(loader, { ttlMs: 100, now: () => clock })
    expect(cache.peek()).toBeUndefined()
    const [x, y] = await Promise.all([cache.get(), cache.get()])
    expect(x).toBe(y)
    expect(loader).toHaveBeenCalledTimes(1)
    clock = 50
    await cache.get()
    expect(loader).toHaveBeenCalledTimes(1)
    expect(cache.peek()).toEqual(["a"])
  })

  it("reloads after the ttl and after clear()", async () => {
    let clock = 0
    const loader = jest.fn(async () => clock)
    const cache = createSearchCache(loader, { ttlMs: 100, now: () => clock })
    await cache.get()
    clock = 150
    expect(cache.peek()).toBeUndefined()
    expect(await cache.get()).toBe(150)
    expect(loader).toHaveBeenCalledTimes(2)
    cache.clear()
    await cache.get()
    expect(loader).toHaveBeenCalledTimes(3)
  })

  it("does not cache a rejected load", async () => {
    let fail = true
    const loader = jest.fn(async () => {
      if (fail) throw new Error("boom")
      return "ok"
    })
    const cache = createSearchCache(loader)
    await expect(cache.get()).rejects.toThrow("boom")
    fail = false
    expect(await cache.get()).toBe("ok")
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("invalidateGlobalSearchCaches clears every cache", async () => {
    const a = createSearchCache(async () => 1)
    const b = createSearchCache(async () => 2)
    await a.get()
    await b.get()
    invalidateGlobalSearchCaches()
    expect(a.peek()).toBeUndefined()
    expect(b.peek()).toBeUndefined()
  })
})
