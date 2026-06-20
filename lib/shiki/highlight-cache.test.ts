// Override the project-wide shiki mock with a jest.fn we can drive per-test
// (the default mirrors __mocks__/shiki.js: resolve to `<pre><code>…</code></pre>`).
jest.mock("shiki", () => ({
  codeToHtml: jest.fn(async (code: string) => `<pre><code>${code}</code></pre>`),
}))

import { codeToHtml } from "shiki"
import { getCachedHighlight, highlightCached, clearHighlightCache } from "./highlight-cache"

describe("highlight-cache", () => {
  beforeEach(() => {
    clearHighlightCache()
  })

  it("misses synchronously before anything is highlighted", () => {
    expect(getCachedHighlight("const x = 1", "ts")).toBeUndefined()
  })

  it("highlights to light + dark HTML and caches the result", async () => {
    const result = await highlightCached("const x = 1", "ts")
    expect(result.light).toContain("const x = 1")
    expect(result.dark).toContain("const x = 1")

    // Now the synchronous lookup hits — this is the flash-free remount path.
    const cached = getCachedHighlight("const x = 1", "ts")
    expect(cached).toBe(result)
  })

  it("returns the same cached object reference on repeat calls", async () => {
    const a = await highlightCached("same code", "js")
    const b = await highlightCached("same code", "js")
    expect(b).toBe(a)
  })

  it("de-dupes concurrent in-flight requests for the same key", async () => {
    const [a, b] = await Promise.all([
      highlightCached("racing", "ts"),
      highlightCached("racing", "ts"),
    ])
    expect(a).toBe(b)
  })

  it("keys on language so the same code under different langs is distinct", async () => {
    const ts = await highlightCached("value", "ts")
    const py = await highlightCached("value", "python")
    expect(getCachedHighlight("value", "ts")).toBe(ts)
    expect(getCachedHighlight("value", "python")).toBe(py)
    expect(ts).not.toBe(py)
  })

  it("keys long snippets on length + head/tail without collision", async () => {
    // >100 chars exercises the tail slice in the cache key.
    const long = "x".repeat(120) + "_END"
    const result = await highlightCached(long, "ts")
    expect(getCachedHighlight(long, "ts")).toBe(result)
    // A snippet sharing the same head but different length/tail must not collide.
    const other = "x".repeat(140) + "_OTHER"
    const otherResult = await highlightCached(other, "ts")
    expect(otherResult).not.toBe(result)
  })

  it("propagates highlight failure, does not cache it, and clears the in-flight entry", async () => {
    ;(codeToHtml as jest.Mock).mockRejectedValueOnce(new Error("shiki boom"))
    await expect(highlightCached("boom", "ts")).rejects.toThrow("shiki boom")
    expect(getCachedHighlight("boom", "ts")).toBeUndefined()
    // In-flight entry was cleared, so a later attempt succeeds and caches.
    const result = await highlightCached("boom", "ts")
    expect(result.light).toContain("boom")
    expect(getCachedHighlight("boom", "ts")).toBe(result)
  })

  it("clearHighlightCache drops cached entries", async () => {
    await highlightCached("temp", "ts")
    expect(getCachedHighlight("temp", "ts")).toBeDefined()
    clearHighlightCache()
    expect(getCachedHighlight("temp", "ts")).toBeUndefined()
  })
})
