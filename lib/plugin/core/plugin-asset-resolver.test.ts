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
    jest.dontMock("@/lib/plugin/bridge/plugin-file-path")
  })

  it("binds the plugin id to the contained native asset reader", async () => {
    const readContainedPluginAsset = jest.fn(async () => "data:font/woff2;base64,AAAA")
    jest.doMock("@/lib/plugin/bridge/plugin-file-path", () => ({
      readContainedPluginAsset,
    }))
    const { createPluginAssetResolver } = await import("./plugin-asset-resolver")
    const resolve = await createPluginAssetResolver("demo")
    await expect(resolve("/plugins/p", "fonts/a.woff2", "font/woff2")).resolves.toBe(
      "data:font/woff2;base64,AAAA"
    )
    expect(readContainedPluginAsset).toHaveBeenCalledWith(
      "demo",
      "/plugins/p",
      "fonts/a.woff2",
      "font/woff2"
    )
  })

  it("propagates containment failures", async () => {
    jest.doMock("@/lib/plugin/bridge/plugin-file-path", () => ({
      readContainedPluginAsset: async () => {
        throw new Error("unsafe plugin path")
      },
    }))
    const { createPluginAssetResolver } = await import("./plugin-asset-resolver")
    const resolve = await createPluginAssetResolver("demo")
    await expect(resolve("/plugins/p", "../outside.woff2")).rejects.toThrow("unsafe plugin path")
  })
})
