import { pluginIconRender } from "./icon-src"

describe("pluginIconRender", () => {
  it("is null without a resolved icon", () => {
    expect(pluginIconRender(undefined)).toBeNull()
  })

  it("passes a lucide name through", () => {
    expect(pluginIconRender({ kind: "lucide", name: "Wrench", original: "Wrench" })).toEqual({
      kind: "lucide",
      name: "Wrench",
    })
  })

  it.each(["inline", "remote", "public"] as const)("renders a %s image directly", (transport) => {
    expect(
      pluginIconRender({ kind: "image", src: "https://x/i.png", original: "x", transport })
    ).toEqual({ kind: "image", src: "https://x/i.png" })
  })

  it("is null for an unresolvable icon", () => {
    expect(pluginIconRender({ kind: "fallback", reason: "outside-plugin-root" })).toBeNull()
  })

  // The resolver turns `assets/icon.png` into an absolute filesystem path,
  // which a webview cannot load. Tauri's asset protocol converts it.
  it("converts a file path through the asset protocol", () => {
    const convert = jest.fn((p: string) => `asset://localhost/${p}`)
    expect(
      pluginIconRender(
        { kind: "image", src: "/plugins/a/icon.png", original: "icon.png", transport: "file" },
        convert
      )
    ).toEqual({ kind: "image", src: "asset://localhost//plugins/a/icon.png" })
    expect(convert).toHaveBeenCalledWith("/plugins/a/icon.png")
  })

  // Off the desktop shell there is no asset protocol. Falling back to the
  // letter avatar beats rendering a broken image.
  it("falls back when no converter is available", () => {
    expect(
      pluginIconRender({
        kind: "image",
        src: "/plugins/a/icon.png",
        original: "icon.png",
        transport: "file",
      })
    ).toBeNull()
  })

  it("falls back when the converter throws", () => {
    const convert = () => {
      throw new Error("no asset scope")
    }
    expect(
      pluginIconRender(
        { kind: "image", src: "/plugins/a/icon.png", original: "icon.png", transport: "file" },
        convert
      )
    ).toBeNull()
  })
})
