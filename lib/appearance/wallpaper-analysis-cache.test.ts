/**
 * @jest-environment jsdom
 */
// jsdom: the cache mirrors into localStorage.
import type { Wallpaper } from "@/types/appearance"
import {
  __INTERNALS__,
  analysisCacheKey,
  readCachedAnalysis,
  readCachedAnalysisFor,
  subscribeAnalysisCache,
  writeCachedAnalysis,
} from "./wallpaper-analysis-cache"
import type { WallpaperThemeAnalysis } from "./wallpaper-theme-generator"

const ANALYSIS: WallpaperThemeAnalysis = {
  accent: "#3b82f6",
  secondary: "#f63b82",
  dominant: "#777777",
  averageLuminance: 0.5,
  luminanceSpread: 0.2,
  darkExtreme: "#111111",
  brightExtreme: "#eeeeee",
  baseVariant: "dark",
}

function image(id: string, relPath: string): Pick<Wallpaper, "id" | "source"> {
  return {
    id,
    source: { kind: "image", storage: "disk", relPath, mime: "image/png", width: 10, height: 10 },
  }
}

beforeEach(() => {
  localStorage.clear()
  __INTERNALS__.resetMemory()
})

describe("analysisCacheKey", () => {
  it("changes when the bytes behind an id change", () => {
    expect(analysisCacheKey(image("w", "a.png"))).not.toBe(analysisCacheKey(image("w", "b.png")))
  })

  it("hashes inline images instead of storing them", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(10_000)}`
    const key = analysisCacheKey({
      id: "preset",
      source: {
        kind: "image",
        storage: "data-url",
        dataUrl,
        mime: "image/png",
        width: 1,
        height: 1,
      },
    })
    expect(key.length).toBeLessThan(64)
  })

  it("distinguishes gradients and colours by value", () => {
    const a = analysisCacheKey({
      id: "g",
      source: { kind: "gradient", css: "linear-gradient(red, blue)" },
    })
    const b = analysisCacheKey({
      id: "g",
      source: { kind: "gradient", css: "linear-gradient(red, lime)" },
    })
    expect(a).not.toBe(b)
    expect(analysisCacheKey({ id: "c", source: { kind: "color", value: "#123" } })).toBe(
      "c:color:#123"
    )
  })
})

describe("read / write", () => {
  it("round-trips through the persisted mirror across sessions", () => {
    writeCachedAnalysis("k", ANALYSIS)
    __INTERNALS__.resetMemory()
    expect(readCachedAnalysis("k")).toEqual(ANALYSIS)
  })

  it("misses cleanly for unknown keys and malformed storage", () => {
    expect(readCachedAnalysis("nope")).toBeNull()
    localStorage.setItem(__INTERNALS__.STORAGE_KEY, "{not json")
    expect(readCachedAnalysis("k")).toBeNull()
  })

  it("drops entries that no longer match the analysis shape", () => {
    localStorage.setItem(
      __INTERNALS__.STORAGE_KEY,
      JSON.stringify([
        ["old", { accent: "#fff" }],
        ["k", ANALYSIS],
      ])
    )
    expect(readCachedAnalysis("old")).toBeNull()
    expect(readCachedAnalysis("k")).toEqual(ANALYSIS)
  })

  it("keeps only the most recent entries", () => {
    for (let i = 0; i <= __INTERNALS__.MAX_ENTRIES; i++) writeCachedAnalysis(`k${i}`, ANALYSIS)
    __INTERNALS__.resetMemory()
    expect(readCachedAnalysis("k0")).toBeNull()
    expect(readCachedAnalysis(`k${__INTERNALS__.MAX_ENTRIES}`)).toEqual(ANALYSIS)
  })

  it("still serves the session when storage refuses the write", () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    writeCachedAnalysis("k", ANALYSIS)
    expect(readCachedAnalysis("k")).toEqual(ANALYSIS)
    setItem.mockRestore()
  })
})

describe("subscribeAnalysisCache", () => {
  it("tells subscribers when an analysis lands, until they unsubscribe", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeAnalysisCache(listener)
    writeCachedAnalysis("k", ANALYSIS)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    writeCachedAnalysis("k2", ANALYSIS)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("keeps notifying the rest when one subscriber throws", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const bad = subscribeAnalysisCache(() => {
      throw new Error("boom")
    })
    const good = jest.fn()
    const off = subscribeAnalysisCache(good)
    writeCachedAnalysis("k", ANALYSIS)
    expect(good).toHaveBeenCalled()
    expect(readCachedAnalysis("k")).toEqual(ANALYSIS)
    bad()
    off()
    warn.mockRestore()
  })
})

describe("readCachedAnalysisFor", () => {
  it("looks a wallpaper up by its cache key", () => {
    const wp = image("w", "a.png")
    expect(readCachedAnalysisFor(wp)).toBeNull()
    writeCachedAnalysis(analysisCacheKey(wp), ANALYSIS)
    expect(readCachedAnalysisFor(wp)).toEqual(ANALYSIS)
    expect(readCachedAnalysisFor(null)).toBeNull()
  })
})
