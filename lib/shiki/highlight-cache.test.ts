// Override the project-wide shiki mock with a jest.fn we can drive per-test
// (the default mirrors __mocks__/shiki.js: resolve to `<pre><code>…</code></pre>`).
const loadLanguageMock = jest.fn()
jest.mock("shiki", () => ({
  codeToHtml: jest.fn(async (code: string) => `<pre><code>${code}</code></pre>`),
  bundledLanguages: { ts: true, js: true, python: true },
  getSingletonHighlighter: jest.fn(async () => ({ loadLanguage: loadLanguageMock })),
}))

import { codeToHtml } from "shiki"
import {
  getCachedHighlight,
  highlightCached,
  clearHighlightCache,
  __resetPluginGrammarLoadsForTesting,
} from "./highlight-cache"
import { registerGrammar, __resetGrammarsForTesting } from "@/lib/plugin/bridge/grammars-bridge"

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

// ── W5.1: plugin grammar loading through the shiki singleton ─────────────────
describe("plugin grammar seam (W5.1)", () => {
  beforeEach(() => {
    clearHighlightCache()
    __resetPluginGrammarLoadsForTesting()
    __resetGrammarsForTesting()
    loadLanguageMock.mockClear()
  })

  it("loads a registered plugin grammar for a non-bundled language once", async () => {
    registerGrammar({
      pluginId: "p1",
      scopeName: "source.svelte",
      language: "svelte",
      grammarPath: "syntaxes/svelte.json",
      payload: JSON.stringify({ scopeName: "source.svelte", patterns: [] }),
    })
    await highlightCached("<div/>", "svelte")
    await highlightCached("<span/>", "svelte")
    expect(loadLanguageMock).toHaveBeenCalledTimes(1)
    expect(loadLanguageMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "svelte", scopeName: "source.svelte" })
    )
  })

  it("does not touch the singleton for bundled or unknown languages", async () => {
    await highlightCached("x", "ts")
    await highlightCached("y", "not-a-language")
    expect(loadLanguageMock).not.toHaveBeenCalled()
  })
})
