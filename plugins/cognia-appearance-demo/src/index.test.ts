/** @cognia-host-integration-test */
// The Neon Noir palette is checked AGAINST the host's contract:
// THEME_TOKEN_CSS_VARS is the set a theme must cover exactly (a partial theme
// leaves every missing surface on the base palette mid-screen), and
// wcagContrast is the ratio the shell will actually render at.
import { wcagContrast } from "@/lib/appearance/contrast"
import { THEME_TOKEN_CSS_VARS } from "@/lib/appearance/theme-token-catalog"
import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import definition, { manifest } from "./index"
import manifestJson from "../plugin.json"

describe("cognia-appearance-demo", () => {
  it("declares the appearance contribution fields with matching capabilities", () => {
    expect(manifestJson.id).toBe("cognia-appearance-demo")
    expect(manifestJson.type).toBe("frontend")
    expect(manifestJson.capabilities).toEqual(
      expect.arrayContaining(["themes", "theme-pack", "wallpapers", "density-preset"])
    )
    expect(manifestJson.wallpapers).not.toHaveLength(0)
    expect(manifestJson.densityPresets).not.toHaveLength(0)
    expect(manifestJson.themePacks).not.toHaveLength(0)
    expect(manifestJson.themes).not.toHaveLength(0)
  })

  it("ships a Neon Noir theme that defines the complete customizable token catalog", () => {
    const [theme] = manifestJson.themes
    expect(theme.id).toBe("neon-noir")
    expect(Object.keys(theme.cssVariables).sort()).toEqual([...THEME_TOKEN_CSS_VARS].sort())
  })

  it("keeps Neon Noir's text pairs legible", () => {
    const vars: Record<string, string> = manifestJson.themes[0].cssVariables
    for (const [foreground, background] of [
      ["--foreground", "--background"],
      ["--card-foreground", "--card"],
      ["--popover-foreground", "--popover"],
      ["--muted-foreground", "--muted"],
      ["--sidebar-foreground", "--sidebar"],
      ["--sidebar-accent-foreground", "--sidebar-accent"],
    ]) {
      expect(wcagContrast(vars[foreground], vars[background])).toBeGreaterThanOrEqual(4.5)
    }
    for (const [foreground, background] of [
      ["--primary-foreground", "--primary"],
      ["--secondary-foreground", "--secondary"],
      ["--accent-foreground", "--accent"],
      ["--destructive-foreground", "--destructive"],
      ["--success-foreground", "--success"],
      ["--warning-foreground", "--warning"],
      ["--info-foreground", "--info"],
      ["--sidebar-primary-foreground", "--sidebar-primary"],
    ]) {
      expect(wcagContrast(vars[foreground], vars[background])).toBeGreaterThanOrEqual(3)
    }
  })

  it("theme pack 'applies' references resolve to this plugin's own contributions", () => {
    const pack = manifestJson.themePacks[0]
    const wallpaperIds = new Set(manifestJson.wallpapers.map((w) => w.id))
    const densityNames = new Set(manifestJson.densityPresets.map((d) => d.name))
    // wallpaperId must name a declared wallpaper; density must name a declared preset.
    expect(wallpaperIds.has(pack.applies.wallpaperId)).toBe(true)
    expect(densityNames.has(pack.applies.density)).toBe(true)
    // radius is clamped to 0..1.5 by the applier; keep the source in range too.
    expect(pack.applies.radius).toBeGreaterThanOrEqual(0)
    expect(pack.applies.radius).toBeLessThanOrEqual(1.5)
    // Motion speed is the user's accessibility preference, not part of a look.
    expect(pack.applies).not.toHaveProperty("motionSpeed")
  })

  it("stays off until the user enables it", () => {
    expect(manifestJson).not.toHaveProperty("activationEvents")
    expect(manifestJson).not.toHaveProperty("activateOnStartup")
    expect(manifestJson.runtimeCompatibility.headless.availability).toBe("blocked")
  })

  it("exports plugin.json itself as the module manifest and passes the host validator", () => {
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
