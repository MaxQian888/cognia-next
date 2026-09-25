import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import definition, { manifest } from "./index"
import manifestJson from "../plugin.json"

describe("cognia-zenless-zone-zero-theme", () => {
  it("declares a complete appearance pack", () => {
    expect(manifestJson.capabilities).toEqual(
      expect.arrayContaining(["themes", "theme-pack", "wallpapers", "density-preset"])
    )
    expect(Object.keys(manifestJson.themes[0].cssVariables)).toHaveLength(56)
    expect(manifestJson.wallpapers).toHaveLength(6)
    expect(manifestJson.themePacks).toHaveLength(5)
  })

  it("keeps every one-click pack reference local", () => {
    const themeIds = new Set(manifestJson.themes.map((theme) => theme.id))
    const wallpaperIds = new Set(manifestJson.wallpapers.map((wallpaper) => wallpaper.id))
    const densities = new Set(manifestJson.densityPresets.map((density) => density.name))
    for (const pack of manifestJson.themePacks) {
      expect(themeIds.has(pack.applies.themeId)).toBe(true)
      expect(wallpaperIds.has(pack.applies.wallpaperId)).toBe(true)
      expect(densities.has(pack.applies.density)).toBe(true)
    }
  })

  it("never overrides the user's motion-speed accessibility preference", () => {
    for (const pack of manifestJson.themePacks) {
      expect(pack.applies).not.toHaveProperty("motionSpeed")
    }
  })

  it("stays off until the user enables it", () => {
    expect(manifestJson).not.toHaveProperty("activationEvents")
    expect(manifestJson).not.toHaveProperty("activateOnStartup")
  })

  it("exports plugin.json itself as the module manifest and passes the host validator", () => {
    // A hand-written subset would be merged OVER plugin.json at discovery and
    // silently drop every field it omitted.
    expect(manifest).toBe(manifestJson)
    expect(definition.manifest).toBe(manifest)
    expect(validatePluginManifest(manifest).errors).toEqual([])
  })

  it("activates without imperative host work", async () => {
    const ctx = {} as Parameters<typeof definition.activate>[0]
    await expect(Promise.resolve(definition.activate(ctx))).resolves.toBeUndefined()
    expect(definition.deactivate).toBeUndefined()
  })
})
