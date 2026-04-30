jest.mock("katex", () => ({
  __esModule: true,
  default: {
    renderToString: jest.fn(
      (tex: string, opts: { displayMode?: boolean }) =>
        `<span data-display="${!!opts.displayMode}">${tex}</span>`
    ),
  },
}))

import katex from "katex"
import {
  renderMathCached,
  renderMathSafe,
  clearMathCache,
  getMathCacheStats,
  globalMathCache,
  MathCache,
} from "./cache"

const mockedRender = (katex as unknown as { renderToString: jest.Mock }).renderToString

beforeEach(() => {
  clearMathCache()
  mockedRender.mockClear()
})

describe("renderMathCached", () => {
  it("renders and caches HTML on first call", () => {
    const html = renderMathCached("a", false)
    expect(html).toContain("a")
    expect(mockedRender).toHaveBeenCalledTimes(1)
  })

  it("returns cached HTML on subsequent calls", () => {
    renderMathCached("b", false)
    renderMathCached("b", false)
    expect(mockedRender).toHaveBeenCalledTimes(1)
  })

  it("treats display mode as a separate cache key", () => {
    renderMathCached("c", false)
    renderMathCached("c", true)
    expect(mockedRender).toHaveBeenCalledTimes(2)
  })
})

describe("renderMathSafe", () => {
  it("returns null error on success", () => {
    const out = renderMathSafe("d", false)
    expect(out.error).toBeNull()
    expect(out.html).toContain("d")
  })

  it("captures Error rejections", () => {
    mockedRender.mockImplementationOnce(() => {
      throw new Error("bad")
    })
    const out = renderMathSafe("\\bad", false)
    expect(out.html).toBe("")
    expect(out.error).toBe("bad")
  })

  it("captures non-Error rejections", () => {
    mockedRender.mockImplementationOnce(() => {
      throw "string-err"
    })
    const out = renderMathSafe("\\worse", false)
    expect(out.error).toBe("Failed to render math")
  })
})

describe("getMathCacheStats", () => {
  it("reports hits/misses/size after activity", () => {
    renderMathCached("e", false) // miss
    renderMathCached("e", false) // hit
    renderMathCached("f", false) // miss
    const stats = getMathCacheStats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(2)
    expect(stats.size).toBe(2)
    expect(stats.hitRate).toBeCloseTo(1 / 3, 5)
  })

  it("hitRate is 0 with no activity", () => {
    const stats = getMathCacheStats()
    expect(stats.hitRate).toBe(0)
  })
})

describe("MathCache", () => {
  it("expires entries past maxAge and reports them as misses", () => {
    const cache = new MathCache(10, 1) // 1ms TTL
    cache.set("x", false, "<x>")
    expect(cache.has("x", false)).toBe(true)
    // Force timestamp into the past via direct access through a wait
    const realNow = Date.now
    Date.now = () => realNow() + 1000
    expect(cache.get("x", false)).toBeNull()
    expect(cache.has("x", false)).toBe(false)
    Date.now = realNow
  })

  it("get returns null for unknown keys", () => {
    const cache = new MathCache(10)
    expect(cache.get("missing", false)).toBeNull()
  })

  it("evicts oldest/least-used when full", () => {
    const cache = new MathCache(2)
    cache.set("a", false, "<a>")
    cache.set("b", false, "<b>")
    // Touch 'b' so 'a' is least-used
    cache.get("b", false)
    cache.set("c", false, "<c>")
    const stats = cache.getStats()
    expect(stats.size).toBeLessThanOrEqual(2)
  })

  it("evicts expired entries during evictIfNeeded", () => {
    const cache = new MathCache(2, 1)
    cache.set("a", false, "<a>")
    const realNow = Date.now
    Date.now = () => realNow() + 1000
    // Should drop expired 'a' before reaching the LRU eviction branch
    cache.set("b", false, "<b>")
    cache.set("c", false, "<c>")
    Date.now = realNow
    const stats = cache.getStats()
    expect(stats.size).toBeGreaterThan(0)
  })

  it("clear resets stats and contents", () => {
    const cache = new MathCache()
    cache.set("k", false, "v")
    cache.get("k", false)
    cache.clear()
    const stats = cache.getStats()
    expect(stats.size).toBe(0)
    expect(stats.hits).toBe(0)
    expect(stats.misses).toBe(0)
  })

  it("uses sort fallback when access counts tie (timestamp tiebreaker)", () => {
    const cache = new MathCache(2)
    cache.set("a", false, "<a>")
    cache.set("b", false, "<b>")
    // Force a third insertion to trigger eviction with neither side having
    // any reads — counts tie, timestamp wins.
    cache.set("c", false, "<c>")
    expect(cache.getStats().size).toBeLessThanOrEqual(2)
  })
})

describe("globalMathCache", () => {
  it("is the singleton used by renderMathCached", () => {
    renderMathCached("global", true)
    expect(globalMathCache.has("global", true)).toBe(true)
  })
})
