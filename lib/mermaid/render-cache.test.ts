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
    expect(svg).toContain("graph TD; A-->B")
    expect(renderMock).toHaveBeenCalledTimes(1)
    // Synchronous lookup now hits — the flash-free remount path.
    expect(getCachedMermaid("default", "graph TD; A-->B")).toBe(svg)
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
