import { resolvePluginIcon } from "./icon"

describe("resolvePluginIcon", () => {
  it("serves a built-in plugin's packaged image from the staged public asset tree", () => {
    expect(
      resolvePluginIcon({ icon: "assets/icon.png", pluginRoot: "builtin://cognia-ocr" })
    ).toEqual({
      kind: "image",
      src: "/_cognia/plugin-icons/cognia-ocr/assets/icon.png",
      original: "assets/icon.png",
      transport: "public",
    })
  })

  it("rejects traversal out of a built-in plugin's asset directory", () => {
    expect(
      resolvePluginIcon({ icon: "../other/icon.png", pluginRoot: "builtin://cognia-ocr" })
    ).toMatchObject({ kind: "fallback", reason: "outside-plugin-root" })
  })

  it("treats Lucide icon names as lucide icons", () => {
    expect(
      resolvePluginIcon({
        icon: "clock",
        pluginRoot: "/plugins/time-tools",
      })
    ).toEqual({
      kind: "lucide",
      name: "clock",
      original: "clock",
    })
  })

  it("preserves remote and data url icons as image sources", () => {
    expect(
      resolvePluginIcon({
        icon: "https://example.com/icon.svg",
        pluginRoot: "/plugins/web-tools",
      })
    ).toEqual({
      kind: "image",
      src: "https://example.com/icon.svg",
      original: "https://example.com/icon.svg",
      transport: "remote",
    })

    expect(
      resolvePluginIcon({
        icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        pluginRoot: "/plugins/web-tools",
      })
    ).toEqual({
      kind: "image",
      src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      original: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      transport: "inline",
    })
  })

  it("resolves plugin-relative icon assets inside the plugin root", () => {
    expect(
      resolvePluginIcon({
        icon: "assets/icon.svg",
        pluginRoot: "D:/Plugins/local-one",
      })
    ).toEqual({
      kind: "image",
      src: "D:/Plugins/local-one/assets/icon.svg",
      original: "assets/icon.svg",
      transport: "file",
    })
  })

  it("rejects icon paths that escape the plugin root", () => {
    expect(
      resolvePluginIcon({
        icon: "../outside/icon.svg",
        pluginRoot: "D:/Plugins/local-one",
      })
    ).toEqual({
      kind: "fallback",
      original: "../outside/icon.svg",
      reason: "outside-plugin-root",
    })
  })
})
