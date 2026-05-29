/**
 * Tests for the cross-runtime plugin asset/path helpers.
 */

import { joinPluginPath } from "./plugin-asset-resolver"

describe("joinPluginPath", () => {
  it("joins root and relative path with a single separator", () => {
    expect(joinPluginPath("/plugins/p", "fonts/a.woff2")).toBe("/plugins/p/fonts/a.woff2")
  })

  it("trims trailing root separators and leading relative separators", () => {
    expect(joinPluginPath("/plugins/p///", "///fonts/a.woff2")).toBe("/plugins/p/fonts/a.woff2")
  })

  it("normalizes only the seam, preserving inner separators (matches bridge behavior)", () => {
    // Only trailing-root and leading-rel separators are trimmed; inner
    // separators pass through unchanged — identical to the inline logic the
    // bridges previously used.
    expect(joinPluginPath("C:\\plugins\\p\\", "\\dist\\index.js")).toBe(
      "C:\\plugins\\p/dist\\index.js"
    )
  })
})

describe("createPluginAssetResolver", () => {
  afterEach(() => {
    jest.resetModules()
    jest.dontMock("@tauri-apps/api/core")
  })

  it("uses Tauri convertFileSrc when available", async () => {
    jest.doMock("@tauri-apps/api/core", () => ({
      convertFileSrc: (p: string) => `asset://localhost/${p}`,
    }))
    const { createPluginAssetResolver } = await import("./plugin-asset-resolver")
    const resolve = await createPluginAssetResolver()
    expect(resolve("/plugins/p", "fonts/a.woff2")).toBe(
      "asset://localhost//plugins/p/fonts/a.woff2"
    )
  })

  it("falls back to the joined path when Tauri is unavailable", async () => {
    jest.doMock("@tauri-apps/api/core", () => {
      throw new Error("not running under Tauri")
    })
    const { createPluginAssetResolver } = await import("./plugin-asset-resolver")
    const resolve = await createPluginAssetResolver()
    expect(resolve("/plugins/p/", "/fonts/a.woff2")).toBe("/plugins/p/fonts/a.woff2")
  })
})
