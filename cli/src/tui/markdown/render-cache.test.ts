import {
  __resetTransientCacheForTesting,
  highlightCached,
  LruCache,
  themeCodeKey,
  tokenizeCached,
  tokenizeTransient,
} from "./render-cache"
import { highlightCode } from "./highlight"
import { tokenizeMarkdown } from "./tokenize"
import { expandPalette, type BaseColors } from "../theme/palette"

const BASE: BaseColors = {
  accent: "cyan",
  secondary: "magenta",
  info: "blue",
  success: "green",
  warning: "yellow",
  danger: "red",
  muted: "gray",
}

describe("LruCache", () => {
  it("returns undefined for a miss and the value for a hit", () => {
    const c = new LruCache<string, number>(2)
    expect(c.get("a")).toBeUndefined()
    c.set("a", 1)
    expect(c.get("a")).toBe(1)
  })

  it("evicts the least-recently-used entry past capacity", () => {
    const c = new LruCache<string, number>(2)
    c.set("a", 1)
    c.set("b", 2)
    c.get("a") // 'a' is now most-recent, so 'b' is the LRU
    c.set("c", 3) // evicts 'b'
    expect(c.get("b")).toBeUndefined()
    expect(c.get("a")).toBe(1)
    expect(c.get("c")).toBe(3)
    expect(c.size).toBe(2)
  })

  it("refreshes recency on overwrite", () => {
    const c = new LruCache<string, number>(2)
    c.set("a", 1)
    c.set("b", 2)
    c.set("a", 10) // overwrite refreshes 'a'
    c.set("c", 3) // evicts 'b', not 'a'
    expect(c.get("a")).toBe(10)
    expect(c.get("b")).toBeUndefined()
  })
})

describe("tokenizeCached", () => {
  it("returns the same result as a direct tokenize", () => {
    const raw = "# H\n\ntext `code`"
    expect(tokenizeCached(raw)).toEqual(tokenizeMarkdown(raw))
  })

  it("returns a stable reference on a repeat call (cache hit)", () => {
    const raw = "## Cached\n\n- a\n- b"
    const first = tokenizeCached(raw)
    expect(tokenizeCached(raw)).toBe(first)
  })
})

describe("tokenizeTransient", () => {
  beforeEach(() => __resetTransientCacheForTesting())

  it("matches a direct tokenize", () => {
    const raw = "# H\n\ngrowing text"
    expect(tokenizeTransient(raw)).toEqual(tokenizeMarkdown(raw))
  })

  it("hits the single-entry cache for the same text", () => {
    const raw = "## Streaming\n\n- a"
    const first = tokenizeTransient(raw)
    expect(tokenizeTransient(raw)).toBe(first)
  })

  it("recomputes when the growing prefix changes", () => {
    const first = tokenizeTransient("hel")
    const second = tokenizeTransient("hello")
    expect(second).not.toBe(first)
    // Single-entry: the previous key is evicted, so re-requesting it recomputes.
    expect(tokenizeTransient("hel")).not.toBe(first)
  })

  it("does not evict the shared tokenizeCached entries", () => {
    const committed = "## Committed cell\n\nbody"
    const cached = tokenizeCached(committed)
    // Stream a flood of distinct growing prefixes — far past the shared LRU cap.
    for (let i = 0; i < 500; i++) tokenizeTransient("x".repeat(i + 1))
    // The committed cell's entry must still be a cache hit (same reference).
    expect(tokenizeCached(committed)).toBe(cached)
  })
})

describe("themeCodeKey", () => {
  it("differs when code colours differ", () => {
    const a = themeCodeKey(expandPalette(BASE))
    const b = themeCodeKey(expandPalette({ ...BASE, secondary: "#abcdef" }))
    expect(a).not.toBe(b)
  })

  it("is stable for an identical palette", () => {
    expect(themeCodeKey(expandPalette(BASE))).toBe(themeCodeKey(expandPalette(BASE)))
  })
})

describe("highlightCached", () => {
  it("matches a direct highlight and caches on the key", () => {
    const code = "const x = 1"
    const direct = highlightCode(code, "typescript", undefined)
    expect(highlightCached(code, "typescript", undefined, "k1")).toBe(direct)
    // Second call hits the cache and returns the identical string.
    expect(highlightCached(code, "typescript", undefined, "k1")).toBe(direct)
  })

  it("returns empty for empty code without caching", () => {
    expect(highlightCached("", "ts", undefined, "k")).toBe("")
  })
})
