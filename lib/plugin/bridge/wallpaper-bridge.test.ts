import {
  __resetPluginWallpapersForTesting,
  applyPluginWallpapers,
  contributionToWallpaper,
  listPluginWallpapers,
  revertPluginWallpapers,
  subscribePluginWallpapers,
} from "./wallpaper-bridge"
import type { PluginWallpaperContribution } from "@/types/plugin/plugin"

beforeEach(() => {
  __resetPluginWallpapersForTesting()
})

const colorContrib: PluginWallpaperContribution = {
  id: "noir",
  name: "Noir",
  source: { kind: "color", value: "#000000" },
}

const gradientContrib: PluginWallpaperContribution = {
  id: "aurora",
  name: "Aurora",
  source: { kind: "gradient", css: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" },
}

const imageContrib: PluginWallpaperContribution = {
  id: "stone",
  name: "Stone",
  source: {
    kind: "image",
    relPath: "assets/stone.jpg",
    mime: "image/jpeg",
    width: 1920,
    height: 1080,
  },
}

const resolveAsset = (root: string, rel: string) => `${root}/${rel}`

describe("contributionToWallpaper", () => {
  it("converts a color contribution", () => {
    const wp = contributionToWallpaper({
      pluginId: "pA",
      contribution: colorContrib,
      resolveAsset,
      pluginRoot: "/p",
    })
    expect(wp.kind).toBe("color")
    expect(wp.builtin).toBe(true)
    expect(wp.id).toBe("plugin-pA-noir")
    expect((wp.source as { value: string }).value).toBe("#000000")
  })

  it("converts a gradient contribution", () => {
    const wp = contributionToWallpaper({
      pluginId: "pA",
      contribution: gradientContrib,
      resolveAsset,
      pluginRoot: "/p",
    })
    expect(wp.kind).toBe("gradient")
    expect((wp.source as { css: string }).css).toContain("linear-gradient")
  })

  it("converts an image contribution using the resolver", () => {
    const wp = contributionToWallpaper({
      pluginId: "pA",
      contribution: imageContrib,
      resolveAsset,
      pluginRoot: "/plugins/pA",
    })
    expect(wp.kind).toBe("image")
    const source = wp.source as {
      storage: string
      dataUrl: string
      mime: string
      width: number
      height: number
    }
    expect(source.dataUrl).toBe("/plugins/pA/assets/stone.jpg")
    expect(source.mime).toBe("image/jpeg")
    expect(source.width).toBe(1920)
  })

  it("throws on contributions missing id or name", () => {
    expect(() =>
      contributionToWallpaper({
        pluginId: "pA",
        contribution: { ...colorContrib, id: "" },
        resolveAsset,
        pluginRoot: "/p",
      })
    ).toThrow(/missing id or name/)
  })
})

describe("applyPluginWallpapers", () => {
  it("registers every successful contribution and lists them", () => {
    const result = applyPluginWallpapers({
      pluginId: "pA",
      pluginRoot: "/p",
      wallpapers: [colorContrib, gradientContrib],
      resolveAsset,
    })
    expect(result.registered).toEqual(["plugin-pA-noir", "plugin-pA-aurora"])
    expect(result.rejected).toEqual([])
    expect(listPluginWallpapers()).toHaveLength(2)
  })

  it("collects errors for individual bad contributions", () => {
    const result = applyPluginWallpapers({
      pluginId: "pA",
      pluginRoot: "/p",
      wallpapers: [colorContrib, { ...gradientContrib, id: "" }],
      resolveAsset,
    })
    expect(result.registered).toHaveLength(1)
    expect(result.rejected).toHaveLength(1)
  })

  it("is idempotent — re-apply replaces the previous set", () => {
    applyPluginWallpapers({
      pluginId: "pA",
      pluginRoot: "/p",
      wallpapers: [colorContrib],
      resolveAsset,
    })
    applyPluginWallpapers({
      pluginId: "pA",
      pluginRoot: "/p",
      wallpapers: [gradientContrib],
      resolveAsset,
    })
    const list = listPluginWallpapers()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe("plugin-pA-aurora")
  })

  it("does not affect other plugins' wallpapers", () => {
    applyPluginWallpapers({
      pluginId: "pA",
      pluginRoot: "/p",
      wallpapers: [colorContrib],
      resolveAsset,
    })
    applyPluginWallpapers({
      pluginId: "pB",
      pluginRoot: "/p",
      wallpapers: [gradientContrib],
      resolveAsset,
    })
    expect(listPluginWallpapers()).toHaveLength(2)
  })
})

describe("revertPluginWallpapers", () => {
  it("removes every wallpaper owned by the plugin and notifies", () => {
    const fires: number[] = []
    subscribePluginWallpapers(() => fires.push(listPluginWallpapers().length))
    applyPluginWallpapers({
      pluginId: "pA",
      pluginRoot: "/p",
      wallpapers: [colorContrib, gradientContrib],
      resolveAsset,
    })
    expect(revertPluginWallpapers("pA")).toBe(2)
    expect(listPluginWallpapers()).toHaveLength(0)
    // 1 apply + 1 revert = 2 notifications
    expect(fires).toHaveLength(2)
  })

  it("returns 0 when nothing to remove", () => {
    expect(revertPluginWallpapers("ghost")).toBe(0)
  })
})
