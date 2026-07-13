import { BUILT_IN_DESIGNED_THEMES } from "./built-in-themes"
import { wcagContrast } from "@/lib/appearance/contrast"
import { THEME_COLOR_KEYS } from "@/lib/appearance/vscode-theme/token-mapping"
import { BUILT_IN_VSCODE_THEMES } from "@/lib/appearance/built-in-vscode-themes"

describe("BUILT_IN_DESIGNED_THEMES", () => {
  it("ships a non-empty curated set", () => {
    expect(BUILT_IN_DESIGNED_THEMES.length).toBeGreaterThanOrEqual(5)
  })

  it("gives every theme a unique name that does not collide with the VSCode presets", () => {
    const names = BUILT_IN_DESIGNED_THEMES.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    const vscodeNames = new Set(BUILT_IN_VSCODE_THEMES.map((t) => t.name))
    for (const name of names) {
      expect(vscodeNames.has(name)).toBe(false)
    }
  })

  it.each(BUILT_IN_DESIGNED_THEMES.map((t) => [t.name, t] as const))(
    "%s carries a complete 27-token palette for both variants",
    (_name, theme) => {
      expect(theme.tokens).toBeDefined()
      for (const variant of ["light", "dark"] as const) {
        const palette = theme.tokens![variant]
        for (const key of THEME_COLOR_KEYS) {
          expect(typeof palette[key]).toBe("string")
          expect(palette[key].length).toBeGreaterThan(0)
        }
      }
    }
  )

  // Two-tier legibility standard so canonical brand colors survive:
  //   - Body/surface text pairs → WCAG AA normal text (4.5:1).
  //   - Interactive chip pairs (button-style, larger/bolder text) → AA large
  //     text (3.0:1). This preserves each palette's signature primary/accent/
  //     destructive hue instead of darkening it just to satisfy small-text AA.
  const BODY_PAIRS: ReadonlyArray<
    [
      (
        | "foreground"
        | "cardForeground"
        | "popoverForeground"
        | "mutedForeground"
        | "sidebarForeground"
      ),
      "background" | "card" | "popover" | "muted" | "sidebar",
    ]
  > = [
    ["foreground", "background"],
    ["cardForeground", "card"],
    ["popoverForeground", "popover"],
    ["mutedForeground", "muted"],
    ["sidebarForeground", "sidebar"],
  ]
  const CHIP_PAIRS: ReadonlyArray<
    [
      "primaryForeground" | "accentForeground" | "destructiveForeground",
      "primary" | "accent" | "destructive",
    ]
  > = [
    ["primaryForeground", "primary"],
    ["accentForeground", "accent"],
    ["destructiveForeground", "destructive"],
  ]

  it.each(BUILT_IN_DESIGNED_THEMES.map((t) => [t.name, t] as const))(
    "%s keeps body/surface text at AA normal (4.5:1) in both variants",
    (_name, theme) => {
      for (const variant of ["light", "dark"] as const) {
        const p = theme.tokens![variant]
        for (const [fg, bg] of BODY_PAIRS) {
          expect(wcagContrast(p[fg], p[bg])).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  )

  it.each(BUILT_IN_DESIGNED_THEMES.map((t) => [t.name, t] as const))(
    "%s keeps interactive chips at least AA large (3.0:1) in both variants",
    (_name, theme) => {
      for (const variant of ["light", "dark"] as const) {
        const p = theme.tokens![variant]
        for (const [fg, bg] of CHIP_PAIRS) {
          expect(wcagContrast(p[fg], p[bg])).toBeGreaterThanOrEqual(3.0)
        }
      }
    }
  )
})
