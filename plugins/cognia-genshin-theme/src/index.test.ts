import definition from "./index"
import manifest from "../plugin.json"

describe("cognia-genshin-theme", () => {
  it("declares a complete appearance pack", () => {
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["themes", "theme-pack", "wallpapers", "density-preset"])
    )
    expect(Object.keys(manifest.themes[0].cssVariables)).toHaveLength(56)
    expect(manifest.wallpapers).toHaveLength(6)
    expect(manifest.themePacks).toHaveLength(5)
  })

  it("keeps every one-click pack reference local", () => {
    const themeIds = new Set(manifest.themes.map((theme) => theme.id))
    const wallpaperIds = new Set(manifest.wallpapers.map((wallpaper) => wallpaper.id))
    const densities = new Set(manifest.densityPresets.map((density) => density.name))
    for (const pack of manifest.themePacks) {
      expect(themeIds.has(pack.applies.themeId)).toBe(true)
      expect(wallpaperIds.has(pack.applies.wallpaperId)).toBe(true)
      expect(densities.has(pack.applies.density)).toBe(true)
    }
  })

  it("activates without host-specific dependencies", async () => {
    const ctx = { pluginId: manifest.id, logger: { info: jest.fn() } } as never
    await expect(definition.activate?.(ctx)).resolves.toBeUndefined()
    await expect(definition.deactivate?.(ctx)).resolves.toBeUndefined()
  })
})
