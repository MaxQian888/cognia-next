import { themeKeyToCssVar, CSS_VAR_KEYS } from "./css-var"
import { THEME_COLOR_KEYS } from "./vscode-theme/token-mapping"

describe("themeKeyToCssVar", () => {
  it.each([
    ["background", "--background"],
    ["primaryForeground", "--primary-foreground"],
    ["sidebarPrimary", "--sidebar-primary"],
    ["sidebarPrimaryForeground", "--sidebar-primary-foreground"],
    ["popoverForeground", "--popover-foreground"],
  ])("converts %s -> %s", (input, expected) => {
    expect(themeKeyToCssVar(input)).toBe(expected)
  })

  it("does not produce a triple-dash for PascalCase", () => {
    expect(themeKeyToCssVar("Primary")).toBe("--primary")
  })
})

describe("CSS_VAR_KEYS", () => {
  it("covers every ThemeColors key", () => {
    expect(CSS_VAR_KEYS.length).toBe(THEME_COLOR_KEYS.length)
  })
  it("every entry starts with --", () => {
    for (const v of CSS_VAR_KEYS) {
      expect(v.startsWith("--")).toBe(true)
    }
  })
})
