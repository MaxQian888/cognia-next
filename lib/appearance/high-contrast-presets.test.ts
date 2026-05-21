import { highContrastOverride } from "./high-contrast-presets"
import { wcagContrast } from "./contrast"

describe("highContrastOverride", () => {
  it("returns null for 'off'", () => {
    expect(highContrastOverride("off")).toBeNull()
  })

  it("returns a fresh object so callers may mutate", () => {
    const a = highContrastOverride("light")
    const b = highContrastOverride("light")
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })

  it.each(["light", "dark"] as const)("%s mode meets WCAG AA on foreground/background", (mode) => {
    const tokens = highContrastOverride(mode)
    expect(tokens).not.toBeNull()
    if (!tokens) return
    const ratio = wcagContrast(tokens.foreground, tokens.background)
    expect(ratio).toBeGreaterThanOrEqual(7) // AAA target
  })

  it.each(["light", "dark"] as const)("%s mode meets AA on primary surfaces", (mode) => {
    const tokens = highContrastOverride(mode)
    if (!tokens) throw new Error("expected tokens")
    expect(wcagContrast(tokens.primaryForeground, tokens.primary)).toBeGreaterThanOrEqual(4.5)
    expect(wcagContrast(tokens.cardForeground, tokens.card)).toBeGreaterThanOrEqual(4.5)
    expect(wcagContrast(tokens.popoverForeground, tokens.popover)).toBeGreaterThanOrEqual(4.5)
    expect(wcagContrast(tokens.destructiveForeground, tokens.destructive)).toBeGreaterThanOrEqual(
      4.5
    )
    expect(wcagContrast(tokens.sidebarForeground, tokens.sidebar)).toBeGreaterThanOrEqual(4.5)
  })
})
