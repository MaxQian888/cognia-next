const mockReadTextFile = jest.fn()
const mockInvoke = jest.fn()
const mockIsTauri = jest.fn()

jest.mock("@/lib/file/file-operations", () => ({
  readTextFile: (...args: unknown[]) => mockReadTextFile(...args),
}))
jest.mock("@/lib/platform/detect", () => ({
  isTauri: () => mockIsTauri(),
}))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import {
  isUnsafeRelativePath,
  joinPluginPath,
  publicBuiltinAssetUrl,
  readContainedPluginAsset,
  readContainedPluginFile,
} from "./plugin-file-path"

describe("plugin-file-path", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
  })

  it("rejects traversal and resolves valid nested paths", () => {
    expect(isUnsafeRelativePath("../outside.json")).toBe(true)
    expect(joinPluginPath("/plugins/demo", "themes/dark.json")).toBe(
      "/plugins/demo/themes/dark.json"
    )
  })

  it("uses the browser file facade outside Tauri", async () => {
    mockReadTextFile.mockResolvedValue("theme")

    await expect(
      readContainedPluginFile("demo", "/plugins/demo", "themes/dark.json")
    ).resolves.toBe("theme")
    expect(mockReadTextFile).toHaveBeenCalledWith("/plugins/demo/themes/dark.json")
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("uses the native no-follow command for installed Tauri plugins", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValue("theme")

    await expect(
      readContainedPluginFile("demo", "/plugins/demo", "themes/dark.json")
    ).resolves.toBe("theme")
    expect(mockInvoke).toHaveBeenCalledWith("plugin_read_entry", {
      pluginId: "demo",
      pluginPath: "/plugins/demo",
      entry: "themes/dark.json",
    })
    expect(mockReadTextFile).not.toHaveBeenCalled()
  })

  it("rejects unsafe paths before invoking either reader", async () => {
    await expect(
      readContainedPluginFile("demo", "/plugins/demo", "../outside.json")
    ).rejects.toThrow(/unsafe plugin path/)
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(mockReadTextFile).not.toHaveBeenCalled()
  })

  it("returns a data URL from the native no-follow binary reader", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValue("AAEC")

    await expect(
      readContainedPluginAsset("demo", "/plugins/demo", "assets/image.png", "image/png")
    ).resolves.toBe("data:image/png;base64,AAEC")
    expect(mockInvoke).toHaveBeenCalledWith("plugin_read_entry_base64", {
      pluginId: "demo",
      pluginPath: "/plugins/demo",
      entry: "assets/image.png",
    })
  })

  it("maps browser-builtin assets to their static public URL", async () => {
    expect(publicBuiltinAssetUrl("cognia-rhodes", "assets/field deck.webp")).toBe(
      "/plugins/cognia-rhodes/assets/field%20deck.webp"
    )
    await expect(
      readContainedPluginAsset(
        "cognia-rhodes",
        "builtin://cognia-rhodes",
        "assets/field deck.webp",
        "image/webp"
      )
    ).resolves.toBe("/plugins/cognia-rhodes/assets/field%20deck.webp")
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("uses the public URL for a built-in asset inside Tauri too", async () => {
    mockIsTauri.mockReturnValue(true)

    await expect(
      readContainedPluginAsset(
        "cognia-rhodes",
        "builtin://cognia-rhodes",
        "assets/wallpaper.webp",
        "image/webp"
      )
    ).resolves.toBe("/plugins/cognia-rhodes/assets/wallpaper.webp")
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  describe("built-in text reads", () => {
    let fetchSpy: jest.SpiedFunction<typeof fetch>

    beforeEach(() => {
      fetchSpy = jest.spyOn(globalThis, "fetch")
    })

    afterEach(() => {
      fetchSpy.mockRestore()
    })

    it("reads a built-in's JSON from its public mirror, not the synthetic root", async () => {
      // `readTextFile("builtin://…")` used to reach `fetch("builtin://…")`, which
      // no browser accepts — so a bundled icon theme could never load.
      fetchSpy.mockResolvedValue(new Response('{"file":"f"}', { status: 200 }))

      await expect(
        readContainedPluginFile(
          "cognia-material-icon-theme",
          "builtin://cognia-material-icon-theme",
          "dist/material-icons.json"
        )
      ).resolves.toBe('{"file":"f"}')
      expect(fetchSpy).toHaveBeenCalledWith(
        "/plugins/cognia-material-icon-theme/dist/material-icons.json"
      )
      expect(mockReadTextFile).not.toHaveBeenCalled()
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it("uses the same mirror inside Tauri, where plugin-fs has no builtin:// file", async () => {
      mockIsTauri.mockReturnValue(true)
      fetchSpy.mockResolvedValue(new Response("theme", { status: 200 }))

      await expect(
        readContainedPluginFile("cognia-rhodes", "builtin://cognia-rhodes", "themes/dark.json")
      ).resolves.toBe("theme")
      expect(fetchSpy).toHaveBeenCalledWith("/plugins/cognia-rhodes/themes/dark.json")
      expect(mockInvoke).not.toHaveBeenCalled()
      expect(mockReadTextFile).not.toHaveBeenCalled()
    })

    it("drops VS Code's leading './' from the mirror URL", async () => {
      fetchSpy.mockResolvedValue(new Response("theme", { status: 200 }))

      await readContainedPluginFile("demo", "builtin://demo", "./dist/theme.json")
      expect(fetchSpy).toHaveBeenCalledWith("/plugins/demo/dist/theme.json")
      expect(publicBuiltinAssetUrl("demo", "./icons/./a b.svg")).toBe(
        "/plugins/demo/icons/a%20b.svg"
      )
    })

    it("surfaces a missing mirror file as an error instead of an empty theme", async () => {
      fetchSpy.mockResolvedValue(new Response("not found", { status: 404 }))

      await expect(
        readContainedPluginFile("demo", "builtin://demo", "dist/missing.json")
      ).rejects.toThrow("HTTP 404 reading built-in plugin asset /plugins/demo/dist/missing.json")
    })

    it("rejects traversal before any request leaves for the mirror", async () => {
      await expect(
        readContainedPluginFile("demo", "builtin://demo", "../other-plugin/theme.json")
      ).rejects.toThrow(/unsafe plugin path/)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  it("rejects unsafe binary asset paths before native invocation", async () => {
    mockIsTauri.mockReturnValue(true)
    await expect(
      readContainedPluginAsset("demo", "/plugins/demo", "..\\outside.png", "image/png")
    ).rejects.toThrow(/unsafe plugin path/)
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
