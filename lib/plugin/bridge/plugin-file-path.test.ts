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

  it("rejects unsafe binary asset paths before native invocation", async () => {
    mockIsTauri.mockReturnValue(true)
    await expect(
      readContainedPluginAsset("demo", "/plugins/demo", "..\\outside.png", "image/png")
    ).rejects.toThrow(/unsafe plugin path/)
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
