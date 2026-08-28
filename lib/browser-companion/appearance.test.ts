import { THEME_TOKEN_CSS_VARS } from "@/lib/appearance/theme-token-catalog"
import type { AppPaletteInput } from "@/lib/appearance/resolve-app-palette"

import {
  appearanceCssVars,
  buildBrowserCompanionAppearance,
  capabilityRevisionOf,
} from "./appearance"

function input(overrides: Partial<AppPaletteInput> = {}): AppPaletteInput {
  return {
    colorTheme: "default",
    resolvedTheme: "light",
    activeCustomThemeId: null,
    customThemes: [],
    ...overrides,
  } as AppPaletteInput
}

describe("appearanceCssVars", () => {
  it("emits exactly the catalog's variable names and nothing invented", () => {
    // The guard for the whole design: the extension writes these names onto
    // <html> verbatim, so a name the app's stylesheet does not read paints
    // nothing and a name the catalog gains later must arrive automatically.
    const vars = Object.keys(appearanceCssVars(input()))
    expect(vars.length).toBeGreaterThan(0)
    expect(vars.every((name) => THEME_TOKEN_CSS_VARS.includes(name))).toBe(true)
    // Names the catalog owns that a camel→kebab guess would have got wrong.
    expect(vars).toContain("--chart-1")
    expect(vars).toContain("--background")
  })

  it("covers every catalog token, so the panel never falls back mid-palette", () => {
    const vars = appearanceCssVars(input())
    const missing = THEME_TOKEN_CSS_VARS.filter((name) => !(name in vars))
    expect(missing).toEqual([])
  })

  it("resolves different values for light and dark rather than one palette", () => {
    const light = appearanceCssVars(input({ resolvedTheme: "light" }))
    const dark = appearanceCssVars(input({ resolvedTheme: "dark" }))
    expect(light["--background"]).not.toBe(dark["--background"])
  })

  it("follows a custom theme instead of the stock palette", () => {
    // Why values travel instead of a theme id: the extension cannot know this
    // palette at build time, and a copied stock palette would be wrong here.
    const custom = appearanceCssVars(
      input({
        activeCustomThemeId: "mine",
        customThemes: [
          {
            id: "mine",
            name: "Mine",
            baseVariant: "light",
            tokens: {
              light: { background: "oklch(0.3 0.1 200)" },
              dark: { background: "oklch(0.2 0.1 200)" },
            },
          },
        ] as unknown as AppPaletteInput["customThemes"],
      })
    )
    expect(custom["--background"]).toBe("oklch(0.3 0.1 200)")
  })
})

describe("buildBrowserCompanionAppearance", () => {
  it("carries the mode, the radius scale and the density", () => {
    const appearance = buildBrowserCompanionAppearance({ ...input(), stylePackId: "sharp" })
    expect(appearance.mode).toBe("light")
    expect(appearance.pillRadiusPx).toBe(0)
    expect(typeof appearance.radiusBaseRem).toBe("number")
    expect(["compact", "comfortable", "spacious"]).toContain(appearance.density)
  })

  it("treats anything that is not light as dark", () => {
    // `resolvedTheme` can be "system" before next-themes settles; a panel that
    // rendered a third state would be showing something the app never shows.
    expect(buildBrowserCompanionAppearance({ ...input({ resolvedTheme: "system" }) }).mode).toBe(
      "dark"
    )
    expect(buildBrowserCompanionAppearance({ ...input({ resolvedTheme: undefined }) }).mode).toBe(
      "dark"
    )
  })

  it("lets an explicit density override the pack's", () => {
    const appearance = buildBrowserCompanionAppearance({
      ...input(),
      stylePackId: "soft",
      density: "compact",
    })
    expect(appearance.density).toBe("compact")
  })
})

describe("capabilityRevisionOf", () => {
  const base = {
    workspaces: [{ id: "ws", label: "Default", isDefault: true }],
    deliveryTargets: [{ id: "chat:new", kind: "chat", label: "New task", isDefault: true }],
    appearance: { mode: "dark", cssVars: { "--background": "black" } },
    followsSystem: false,
  }

  it("is stable for the same answer", () => {
    // Polled every few seconds. A digest that moved on its own would repaint
    // the panel on nothing.
    expect(capabilityRevisionOf(base)).toBe(capabilityRevisionOf({ ...base }))
  })

  it("moves when any part of the answer does", () => {
    const original = capabilityRevisionOf(base)
    expect(
      capabilityRevisionOf({
        ...base,
        appearance: { mode: "light", cssVars: { "--background": "white" } },
      })
    ).not.toBe(original)
    expect(capabilityRevisionOf({ ...base, workspaces: [] })).not.toBe(original)
    expect(capabilityRevisionOf({ ...base, deliveryTargets: [] })).not.toBe(original)
    // Including the flag, because a Host that starts following the system is a
    // Host the panel has to answer for.
    expect(capabilityRevisionOf({ ...base, followsSystem: true })).not.toBe(original)
  })

  it("treats an absent target list as an empty answer, not as a different one", () => {
    const { deliveryTargets: _dropped, ...without } = base
    expect(capabilityRevisionOf(without)).toBe(
      capabilityRevisionOf({ ...without, deliveryTargets: undefined })
    )
  })
})
