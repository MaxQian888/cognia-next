/** @cognia-host-integration-test */
// The theme is checked AGAINST the host's contract, which is the only way
// to check it: THEME_TOKEN_CSS_VARS is the set a pack must cover exactly,
// and wcagContrast is the ratio the shell will actually render at. A copy
// of either here would pass while the real thing drifted.
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { wcagContrast } from "@/lib/appearance/contrast"
import { THEME_TOKEN_CSS_VARS } from "@/lib/appearance/theme-token-catalog"
import definition from "./index"
import manifest from "../plugin.json"

const publicPluginRoot = join(__dirname, "../../../public/plugins/cognia-arknights-theme")

describe("cognia-arknights-theme", () => {
  it("declares every appearance contribution lane and supports each interactive shell", () => {
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["themes", "theme-pack", "wallpapers", "density-preset"])
    )
    expect(manifest.runtimeCompatibility).toMatchObject({
      browser: { availability: "supported" },
      tauri: { availability: "supported" },
      mobile: { availability: "supported" },
    })
  })

  it.each(manifest.themes)("$name defines the complete customizable token catalog", (theme) => {
    expect(Object.keys(theme.cssVariables).sort()).toEqual([...THEME_TOKEN_CSS_VARS].sort())
  })

  it.each(manifest.themes)("$name keeps primary UI text pairs legible", (theme) => {
    const vars = theme.cssVariables
    for (const [foreground, background] of [
      ["--foreground", "--background"],
      ["--card-foreground", "--card"],
      ["--popover-foreground", "--popover"],
      ["--muted-foreground", "--muted"],
      ["--sidebar-foreground", "--sidebar"],
    ] as const) {
      expect(wcagContrast(vars[foreground], vars[background])).toBeGreaterThanOrEqual(4.5)
    }
    for (const [foreground, background] of [
      ["--primary-foreground", "--primary"],
      ["--accent-foreground", "--accent"],
      ["--destructive-foreground", "--destructive"],
    ] as const) {
      expect(wcagContrast(vars[foreground], vars[background])).toBeGreaterThanOrEqual(3)
    }
  })

  it("keeps every theme-pack reference inside the plugin manifest", () => {
    const themeIds = new Set(manifest.themes.map((theme) => theme.id))
    const wallpaperIds = new Set(manifest.wallpapers.map((wallpaper) => wallpaper.id))
    const densityNames = new Set(manifest.densityPresets.map((density) => density.name))

    for (const pack of manifest.themePacks) {
      expect(themeIds.has(pack.applies.themeId)).toBe(true)
      expect(wallpaperIds.has(pack.applies.wallpaperId)).toBe(true)
      expect(densityNames.has(pack.applies.density)).toBe(true)
      expect(pack.applies.radius).toBeGreaterThanOrEqual(0)
      expect(pack.applies.radius).toBeLessThanOrEqual(1.5)
    }
  })

  it("ships valid generated WebP wallpapers and a vector plugin icon", () => {
    for (const wallpaper of manifest.wallpapers) {
      if (wallpaper.source.kind !== "image") continue
      const bytes = readFileSync(join(publicPluginRoot, wallpaper.source.relPath))
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF")
      expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP")
    }
    expect(readFileSync(join(publicPluginRoot, "assets/command-emblem.svg"), "utf8")).toContain(
      "<svg"
    )
  })

  it("activates and deactivates without imperative host dependencies", async () => {
    const ctx = { pluginId: manifest.id, logger: { info: jest.fn() } } as never
    await expect(definition.activate?.(ctx)).resolves.toBeUndefined()
    await expect(definition.deactivate?.(ctx)).resolves.toBeUndefined()
  })
})
