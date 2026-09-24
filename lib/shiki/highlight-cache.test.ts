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
    ;(codeToHtml as jest.Mock)
      .mockReset()
      .mockImplementation(async (code: string) => `<pre><code>${code}</code></pre>`)
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

  it("distinguishes snippets with different lengths and tails", async () => {
    // >100 chars exercises the tail slice in the cache key.
    const long = "x".repeat(120) + "_END"
    const result = await highlightCached(long, "ts")
    expect(getCachedHighlight(long, "ts")).toBe(result)
    // A snippet sharing the same head but different length/tail must not collide.
    const other = "x".repeat(140) + "_OTHER"
    const otherResult = await highlightCached(other, "ts")
    expect(otherResult).not.toBe(result)
  })

  it.each([false, true])(
    "keeps equal-length snippets with identical ends distinct (concurrent=%s)",
    async (concurrent) => {
      const first = "x".repeat(100) + "FIRST" + "y".repeat(100)
      const second = "x".repeat(100) + "OTHER" + "y".repeat(100)
      const firstTask = highlightCached(first, "ts")
      if (!concurrent) await firstTask
      const [a, b] = await Promise.all([firstTask, highlightCached(second, "ts")])
      expect(a.light).toContain("FIRST")
      expect(b.light).toContain("OTHER")
      expect(getCachedHighlight(first, "ts")).toBe(a)
      expect(getCachedHighlight(second, "ts")).toBe(b)
    }
  )

  it("evicts large results by payload weight while keeping recently reused code", async () => {
    const output = "x".repeat(1_000_000)
    ;(codeToHtml as jest.Mock).mockResolvedValue(output)
    const first = await highlightCached("first", "ts")
    await highlightCached("second", "ts")
    await highlightCached("third", "ts")
    await highlightCached("fourth", "ts")
    expect(getCachedHighlight("first", "ts")).toBe(first)
    await highlightCached("fifth", "ts")
    expect(getCachedHighlight("first", "ts")).toBe(first)
    expect(getCachedHighlight("second", "ts") === undefined).toBe(true)
    expect(getCachedHighlight("fifth", "ts")).toBeDefined()
  })

  it("returns oversized highlights without retaining or evicting useful cached code", async () => {
    const small = await highlightCached("small", "ts")
    const output = "x".repeat(5_000_000)
    ;(codeToHtml as jest.Mock).mockResolvedValue(output)
    const result = await highlightCached("huge", "ts")
    expect(result).toEqual({ light: output, dark: output })
    expect(getCachedHighlight("huge", "ts") === undefined).toBe(true)
    expect(getCachedHighlight("small", "ts")).toBe(small)
  })

  it("includes retained source keys in the budget even when highlighted output is small", async () => {
    const source = "x".repeat(9 * 1024 * 1024)
    ;(codeToHtml as jest.Mock).mockResolvedValue("<pre />")
    await highlightCached(source, "ts")
    expect(getCachedHighlight(source, "ts") === undefined).toBe(true)
  })

  it("retains the 300-entry ceiling for small highlights", async () => {
    for (let index = 0; index < 301; index += 1) {
      await highlightCached(`small-${index}`, "ts")
    }
    expect(getCachedHighlight("small-0", "ts")).toBeUndefined()
    expect(getCachedHighlight("small-1", "ts")).toBeDefined()
    expect(getCachedHighlight("small-300", "ts")).toBeDefined()
  })

  it("does not repopulate a cleared cache with active or queued old work", async () => {
    let release!: (value: string) => void
    let started!: () => void
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    ;(codeToHtml as jest.Mock).mockImplementationOnce(() => {
      started()
      return new Promise<string>((resolve) => {
        release = resolve
      })
    })
    const active = highlightCached("active", "ts")
    const queued = highlightCached("queued", "ts")
    await start
    clearHighlightCache()
    release("active light")
    await Promise.all([active, queued])
    expect(getCachedHighlight("active", "ts")).toBeUndefined()
    expect(getCachedHighlight("queued", "ts")).toBeUndefined()
  })

  it("old work cannot remove a newer pending request after clearing", async () => {
    let releaseOld!: (value: string) => void
    let releaseNew!: (value: string) => void
    let startOld!: () => void
    let startNew!: () => void
    const oldStarted = new Promise<void>((resolve) => {
      startOld = resolve
    })
    const newStarted = new Promise<void>((resolve) => {
      startNew = resolve
    })
    const mock = codeToHtml as jest.Mock
    mock
      .mockImplementationOnce(() => {
        startOld()
        return new Promise<string>((resolve) => {
          releaseOld = resolve
        })
      })
      .mockResolvedValueOnce("old dark")
      .mockImplementationOnce(() => {
        startNew()
        return new Promise<string>((resolve) => {
          releaseNew = resolve
        })
      })
      .mockRejectedValueOnce(new Error("new highlight failed"))
    const old = highlightCached("same", "ts")
    await oldStarted
    clearHighlightCache()
    const fresh = highlightCached("same", "ts")
    releaseOld("old light")
    await old
    await newStarted
    const duplicate = highlightCached("same", "ts")
    const results = Promise.allSettled([fresh, duplicate])
    releaseNew("new light")
    expect(await results).toEqual([
      { status: "rejected", reason: new Error("new highlight failed") },
      { status: "rejected", reason: new Error("new highlight failed") },
    ])
    expect(mock).toHaveBeenCalledTimes(4)
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

  describe("serialization gate", () => {
    it("runs distinct snippets one at a time rather than interleaving them", async () => {
      // N concurrent tokenisations do not finish sooner than N sequential ones;
      // they fuse into one long main-thread block instead of N the browser can
      // schedule around. Scrolling a code-heavy transcript mounts a screenful
      // of distinct fences at once, each of them two passes.
      const mock = codeToHtml as jest.Mock
      mock.mockClear()
      let concurrent = 0
      let peak = 0
      mock.mockImplementation(async (code: string) => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await Promise.resolve()
        concurrent -= 1
        return `<pre><code>${code}</code></pre>`
      })

      await Promise.all([
        highlightCached("const a = 1", "ts"),
        highlightCached("const b = 2", "ts"),
        highlightCached("const c = 3", "ts"),
      ])

      expect(peak).toBe(1)
    })

    it("re-checks the cache after waiting its turn", async () => {
      // A duplicate that queued behind an identical pass must not tokenise
      // again once that pass has filled the cache.
      const mock = codeToHtml as jest.Mock
      mock.mockClear()
      mock.mockImplementation(async (code: string) => `<pre><code>${code}</code></pre>`)

      // Distinct in-flight keys (the inflight map only de-dupes identical ones),
      // then a third call for a key the first already cached.
      await highlightCached("shared", "ts")
      const callsAfterFirst = mock.mock.calls.length
      await highlightCached("shared", "ts")

      expect(mock.mock.calls.length).toBe(callsAfterFirst)
    })

    it("keeps the queue usable after a failed highlight", async () => {
      const mock = codeToHtml as jest.Mock
      mock.mockClear()
      mock.mockImplementationOnce(async () => {
        throw new Error("tokenise failed")
      })
      mock.mockImplementation(async (code: string) => `<pre><code>${code}</code></pre>`)

      await expect(highlightCached("boom", "ts")).rejects.toThrow("tokenise failed")
      await expect(highlightCached("fine", "ts")).resolves.toMatchObject({
        light: expect.stringContaining("fine"),
      })
    })
  })
})
