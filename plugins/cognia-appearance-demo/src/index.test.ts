import definition from "./index"
import manifest from "../plugin.json"

describe("cognia-appearance-demo", () => {
  it("declares the appearance contribution fields with matching capabilities", () => {
    expect(manifest.id).toBe("cognia-appearance-demo")
    expect(manifest.type).toBe("frontend")
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["theme-pack", "wallpapers", "density-preset"])
    )
    expect(manifest.wallpapers).not.toHaveLength(0)
    expect(manifest.densityPresets).not.toHaveLength(0)
    expect(manifest.themePacks).not.toHaveLength(0)
  })

  it("theme pack 'applies' references resolve to this plugin's own contributions", () => {
    const pack = manifest.themePacks[0]
    const wallpaperIds = new Set(manifest.wallpapers.map((w) => w.id))
    const densityNames = new Set(manifest.densityPresets.map((d) => d.name))
    // wallpaperId must name a declared wallpaper; density must name a declared preset.
    expect(wallpaperIds.has(pack.applies.wallpaperId)).toBe(true)
    expect(densityNames.has(pack.applies.density)).toBe(true)
    // radius is clamped to 0..1.5 by the applier; keep the source in range too.
    expect(pack.applies.radius).toBeGreaterThanOrEqual(0)
    expect(pack.applies.radius).toBeLessThanOrEqual(1.5)
  })

  it("activate / deactivate are no-throw with a minimal context", async () => {
    const ctx = { pluginId: manifest.id, logger: { info: jest.fn() } } as never
    await expect(definition.activate?.(ctx)).resolves.toBeUndefined()
    await expect(definition.deactivate?.(ctx)).resolves.toBeUndefined()
  })
})
