import { applyThemePack, type ThemePackApplyDeps } from "./theme-pack-applier"
import type { RegisteredThemePack } from "./theme-pack-registry"
import type { PluginTheme } from "./theme-registry"
import type { ThemeColors } from "@/types/plugin/plugin-extended"

const COLORS = { background: "#ffffff", foreground: "#000000" } as unknown as ThemeColors

function makePack(applies: RegisteredThemePack["applies"], pluginId = "demo"): RegisteredThemePack {
  return { id: "pack1", name: "Pack One", pluginId, applies }
}

function makeDeps(over: Partial<ThemePackApplyDeps> = {}): ThemePackApplyDeps {
  return {
    settings: {},
    pluginThemes: [],
    save: jest.fn(),
    setActiveWallpaper: jest.fn(),
    setActiveCustomTheme: jest.fn(),
    createCustomTheme: jest.fn(() => "ct_new"),
    applyDensityPreset: jest.fn(() => true),
    ...over,
  }
}

describe("applyThemePack", () => {
  it("applies a host colour preset via save({colorTheme}) and clears active custom theme", () => {
    const deps = makeDeps()
    const res = applyThemePack(makePack({ themeId: "ocean" }), deps)
    expect(deps.save).toHaveBeenCalledWith({ colorTheme: "ocean" })
    expect(deps.setActiveCustomTheme).toHaveBeenCalledWith(null)
    expect(res.applied).toContain("theme:preset")
  })

  it("clones a plugin theme into a CustomTheme and activates it", () => {
    const pluginThemes: PluginTheme[] = [
      {
        id: "midnight",
        name: "Midnight",
        colors: COLORS,
        isDark: true,
        pluginId: "demo",
        variables: {},
      },
    ]
    const deps = makeDeps({ pluginThemes })
    const res = applyThemePack(makePack({ themeId: "midnight" }), deps)
    expect(deps.createCustomTheme).toHaveBeenCalledTimes(1)
    expect(deps.setActiveCustomTheme).toHaveBeenCalledWith("ct_new")
    expect(res.applied).toContain("theme:plugin")
  })

  it("reuses an existing clone instead of creating a duplicate", () => {
    const pluginThemes: PluginTheme[] = [
      {
        id: "midnight",
        name: "Midnight",
        colors: COLORS,
        isDark: true,
        pluginId: "demo",
        variables: {},
      },
    ]
    const deps = makeDeps({
      pluginThemes,
      settings: {
        customThemes: [{ id: "ct_existing", name: "Midnight", sourcePluginId: "demo" } as never],
      },
    })
    applyThemePack(makePack({ themeId: "midnight" }), deps)
    expect(deps.createCustomTheme).not.toHaveBeenCalled()
    expect(deps.setActiveCustomTheme).toHaveBeenCalledWith("ct_existing")
  })

  it("skips an unresolved themeId", () => {
    const res = applyThemePack(makePack({ themeId: "nope" }), makeDeps())
    expect(res.skipped).toContainEqual({ field: "themeId", reason: "unresolved" })
  })

  it("merges font families into typographyExt", () => {
    const deps = makeDeps({ settings: { typographyExt: { fontFamily: "old" } } })
    applyThemePack(makePack({ fontFamily: "Inter", monoFamily: "JetBrains" }), deps)
    expect(deps.save).toHaveBeenCalledWith(
      expect.objectContaining({
        typographyExt: expect.objectContaining({ fontFamily: "Inter", monoFamily: "JetBrains" }),
      })
    )
  })

  it("namespaces wallpaperId to the registered plugin id form", () => {
    const deps = makeDeps()
    applyThemePack(makePack({ wallpaperId: "aurora" }, "acme"), deps)
    expect(deps.setActiveWallpaper).toHaveBeenCalledWith("plugin-acme-aurora")
  })

  it("applies a canonical density level via save", () => {
    const deps = makeDeps()
    const res = applyThemePack(makePack({ density: "compact" }), deps)
    expect(deps.save).toHaveBeenCalledWith(
      expect.objectContaining({ density: expect.objectContaining({ global: "compact" }) })
    )
    expect(res.applied).toContain("density:level")
  })

  it("applies a named density preset via the injected applier; skips unknown ones", () => {
    const ok = makeDeps({ applyDensityPreset: jest.fn(() => true) })
    expect(applyThemePack(makePack({ density: "airy" }), ok).applied).toContain("density:preset")

    const bad = makeDeps({ applyDensityPreset: jest.fn(() => false) })
    expect(applyThemePack(makePack({ density: "ghost" }), bad).skipped).toContainEqual({
      field: "density",
      reason: "unknown-preset",
    })
  })

  it("clamps radius into 0..1.5", () => {
    const deps = makeDeps()
    applyThemePack(makePack({ radius: 9 }), deps)
    expect(deps.save).toHaveBeenCalledWith(
      expect.objectContaining({ radius: expect.objectContaining({ base: 1.5 }) })
    )
  })

  it("applies motion speed", () => {
    const deps = makeDeps()
    applyThemePack(makePack({ motionSpeed: 1.5 }), deps)
    expect(deps.save).toHaveBeenCalledWith(
      expect.objectContaining({ motion: expect.objectContaining({ speed: 1.5 }) })
    )
  })

  it("reports monacoTheme as canvas-owned rather than applying it", () => {
    const res = applyThemePack(makePack({ monacoTheme: "vs-dark" }), makeDeps())
    expect(res.skipped).toContainEqual({ field: "monacoTheme", reason: "canvas-subsystem-owned" })
  })
})
