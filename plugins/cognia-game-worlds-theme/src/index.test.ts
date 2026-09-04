import definition, { gameWorldsManifest } from "./index"
import baseManifest from "../plugin.json"

describe("cognia-game-worlds-theme", () => {
  it("ships its contributions in the manifest FILE, not only at runtime", () => {
    // Working Rule 7: a declared capability whose contribution field is empty
    // is a dormant tag. `builtinManifest` merges the module's manifest over the
    // JSON, so building the blocks in `index.ts` alone still works at runtime
    // and leaves every reader of `plugin.json` looking at four tags backed by
    // nothing: `cognia plugin lint`, packaging, the marketplace listing. The
    // five sibling theme plugins all carry the blocks in the file.
    const declared: Record<string, keyof typeof gameWorldsManifest> = {
      themes: "themes",
      "theme-pack": "themePacks",
      wallpapers: "wallpapers",
      "density-preset": "densityPresets",
    }
    for (const [capability, field] of Object.entries(declared)) {
      expect(baseManifest.capabilities).toContain(capability)
      expect((baseManifest as Record<string, unknown>)[field]).toHaveLength(
        (gameWorldsManifest[field] as unknown[]).length
      )
    }
  })

  it("declares a broad and complete appearance collection", () => {
    expect(gameWorldsManifest.capabilities).toEqual(
      expect.arrayContaining(["themes", "theme-pack", "wallpapers", "density-preset"])
    )
    expect(gameWorldsManifest.themes).toHaveLength(8)
    expect(gameWorldsManifest.wallpapers).toHaveLength(40)
    expect(gameWorldsManifest.themePacks).toHaveLength(40)
    expect(gameWorldsManifest.densityPresets).toHaveLength(2)

    for (const theme of gameWorldsManifest.themes) {
      expect(Object.keys(theme.cssVariables)).toHaveLength(56)
    }
  })

  it("keeps every one-click pack reference inside the collection", () => {
    const themeIds = new Set(gameWorldsManifest.themes.map((theme) => theme.id))
    const wallpaperIds = new Set(gameWorldsManifest.wallpapers.map((wallpaper) => wallpaper.id))
    const densities = new Set(gameWorldsManifest.densityPresets.map((density) => density.name))

    for (const pack of gameWorldsManifest.themePacks) {
      expect(themeIds.has(pack.applies.themeId)).toBe(true)
      expect(wallpaperIds.has(pack.applies.wallpaperId)).toBe(true)
      expect(densities.has(pack.applies.density)).toBe(true)
      expect(pack.preview.light).toBe(pack.preview.dark)
      expect(pack.preview.light).toMatch(/^\/plugins\/cognia-game-worlds-theme\/assets\/.+\.webp$/)
    }
  })

  it("activates without host-specific dependencies", async () => {
    const ctx = { pluginId: gameWorldsManifest.id, logger: { info: jest.fn() } } as never
    await expect(definition.activate?.(ctx)).resolves.toBeUndefined()
    await expect(definition.deactivate?.(ctx)).resolves.toBeUndefined()
  })
})
