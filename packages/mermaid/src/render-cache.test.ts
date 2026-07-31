/** @jest-environment jsdom */
const renderMock = jest.fn(async (id: string, source: string) => ({
  svg: `<svg data-id="${id}">${source}</svg>`,
}))
const initializeMock = jest.fn()

jest.mock("mermaid", () => ({
  __esModule: true,
  default: {
    initialize: initializeMock,
    render: renderMock,
  },
}))

import { getCachedMermaid, renderMermaidCached, clearMermaidCache } from "./render-cache"

describe("mermaid render-cache", () => {
  beforeEach(() => {
    clearMermaidCache()
    renderMock.mockClear()
    initializeMock.mockClear()
  })

  it("misses synchronously before anything is rendered", () => {
    expect(getCachedMermaid("dark", "graph TD; A-->B")).toBeUndefined()
  })

  it("renders the source to SVG and caches it", async () => {
    const svg = await renderMermaidCached("default", "graph TD; A-->B")
    // Entity-escaped: what is cached is the output of `sanitizeMermaidSvg`,
    // which round-trips the markup through the DOM before any caller injects
    // it. `>` in text content comes back as `&gt;`.
    expect(svg).toContain("graph TD; A--&gt;B")
    expect(renderMock).toHaveBeenCalledTimes(1)
    // Synchronous lookup now hits — the flash-free remount path.
    expect(getCachedMermaid("default", "graph TD; A-->B")).toBe(svg)
  })

  it("renders one diagram at a time so a theme flip cannot pile up", async () => {
    // A theme toggle in a diagram-heavy session re-renders every visible
    // diagram. Concurrent CPU-bound layout does not finish sooner — it fuses
    // into one unbroken main-thread block.
    let live = 0
    let peak = 0
    renderMock.mockImplementation(async (id: string, source: string) => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 0))
      live -= 1
      return { svg: `<svg data-id="${id}">${source}</svg>` }
    })

    await Promise.all(
      ["one", "two", "three", "four"].map((source) => renderMermaidCached("default", source))
    )

    expect(peak).toBe(1)
    expect(renderMock).toHaveBeenCalledTimes(4)
  })

  it("keeps a rejected render from stalling the queue behind it", async () => {
    renderMock.mockRejectedValueOnce(new Error("bad syntax"))

    await expect(renderMermaidCached("default", "broken")).rejects.toThrow("bad syntax")
    await expect(renderMermaidCached("default", "fine")).resolves.toContain("<svg")
  })

  it("does not re-render a cached (theme, source) pair", async () => {
    await renderMermaidCached("dark", "pie")
    await renderMermaidCached("dark", "pie")
    expect(renderMock).toHaveBeenCalledTimes(1)
  })

  it("initializes mermaid with the requested theme", async () => {
    await renderMermaidCached("dark", "sequenceDiagram")
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark", startOnLoad: false })
    )
  })

  it("enables suppressErrorRendering so a failed render cleans up its temp DOM", async () => {
    // Without this flag, mermaid.render() leaves the "Syntax error in text"
    // graphic appended to document.body and throws before cleanup runs, so the
    // orphaned error stays on the page forever (and accumulates one per error).
    await renderMermaidCached("dark", "graph TD; A-->B")
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ suppressErrorRendering: true })
    )
  })

  it("keys on theme so light vs dark are cached separately", async () => {
    const dark = await renderMermaidCached("dark", "graph LR; X-->Y")
    const light = await renderMermaidCached("default", "graph LR; X-->Y")
    expect(getCachedMermaid("dark", "graph LR; X-->Y")).toBe(dark)
    expect(getCachedMermaid("default", "graph LR; X-->Y")).toBe(light)
    expect(renderMock).toHaveBeenCalledTimes(2)
  })

  it("de-dupes concurrent renders of the same key", async () => {
    const [a, b] = await Promise.all([
      renderMermaidCached("dark", "racing"),
      renderMermaidCached("dark", "racing"),
    ])
    expect(a).toBe(b)
    expect(renderMock).toHaveBeenCalledTimes(1)
  })

  it("propagates render failures and does not cache them", async () => {
    renderMock.mockRejectedValueOnce(new Error("parse error"))
    await expect(renderMermaidCached("dark", "bad")).rejects.toThrow("parse error")
    expect(getCachedMermaid("dark", "bad")).toBeUndefined()
    // A later successful render still works (in-flight entry was cleared).
    const svg = await renderMermaidCached("dark", "bad")
    expect(svg).toContain("bad")
  })

  it("clearMermaidCache drops cached diagrams", async () => {
    await renderMermaidCached("dark", "temp")
    expect(getCachedMermaid("dark", "temp")).toBeDefined()
    clearMermaidCache()
    expect(getCachedMermaid("dark", "temp")).toBeUndefined()
  })
})
