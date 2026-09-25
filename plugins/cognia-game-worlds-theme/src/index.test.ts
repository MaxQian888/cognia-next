import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import definition, { GAME_WORLDS_APPEARANCE, manifest } from "./index"
import manifestJson from "../plugin.json"

describe("cognia-game-worlds-theme", () => {
  it("ships exactly the generated contributions in the manifest FILE", () => {
    // Working Rule 7: a declared capability whose contribution field is empty
    // is a dormant tag, and a file that merely has the right LENGTH can still
    // carry a stale palette or a pack the generator no longer emits. Every
    // reader of plugin.json (`cognia plugin lint`, packaging, the marketplace
    // listing) sees the file, and the runtime sees the generator, so the two
    // must be the same data, entry for entry.
    const declared = {
      themes: "themes",
      "theme-pack": "themePacks",
      wallpapers: "wallpapers",
      "density-preset": "densityPresets",
    } as const
    for (const [capability, field] of Object.entries(declared)) {
      expect(manifestJson.capabilities).toContain(capability)
      expect(manifestJson[field]).toStrictEqual(GAME_WORLDS_APPEARANCE[field])
    }
  })

  it("declares a broad and complete appearance collection", () => {
    expect(manifestJson.themes).toHaveLength(8)
    expect(manifestJson.wallpapers).toHaveLength(40)
    expect(manifestJson.themePacks).toHaveLength(40)
    expect(manifestJson.densityPresets).toHaveLength(2)

    for (const theme of manifestJson.themes) {
      expect(Object.keys(theme.cssVariables)).toHaveLength(56)
    }
  })

  it("keeps every one-click pack reference inside the collection", () => {
    const themeIds = new Set(manifestJson.themes.map((theme) => theme.id))
    const wallpaperIds = new Set(manifestJson.wallpapers.map((wallpaper) => wallpaper.id))
    const densities = new Set(manifestJson.densityPresets.map((density) => density.name))

    for (const pack of manifestJson.themePacks) {
      expect(themeIds.has(pack.applies.themeId)).toBe(true)
      expect(wallpaperIds.has(pack.applies.wallpaperId)).toBe(true)
      expect(densities.has(pack.applies.density)).toBe(true)
      expect(pack.preview.light).toBe(pack.preview.dark)
      expect(pack.preview.light).toMatch(/^\/plugins\/cognia-game-worlds-theme\/assets\/.+\.webp$/)
    }
  })

  it("never overrides the user's motion-speed accessibility preference", () => {
    for (const pack of GAME_WORLDS_APPEARANCE.themePacks) {
      expect(pack.applies).not.toHaveProperty("motionSpeed")
    }
  })

  it("stays off until the user enables it", () => {
    expect(manifestJson).not.toHaveProperty("activationEvents")
    expect(manifest).not.toHaveProperty("activationEvents")
  })

  it("keeps every plugin.json field on the module manifest and passes the host validator", () => {
    expect(manifest).toMatchObject({
      id: manifestJson.id,
      license: manifestJson.license,
      runtimeCompatibility: manifestJson.runtimeCompatibility,
    })
    expect(definition.manifest).toBe(manifest)
    expect(validatePluginManifest(manifest).errors).toEqual([])
  })

  it("activates without imperative host work", async () => {
    const ctx = {} as Parameters<typeof definition.activate>[0]
    await expect(Promise.resolve(definition.activate(ctx))).resolves.toBeUndefined()
    expect(definition.deactivate).toBeUndefined()
  })
})
