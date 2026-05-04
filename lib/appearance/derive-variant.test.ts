import { deriveOppositeVariant, deriveTokenColor } from "./derive-variant"
import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { wcagContrast } from "./contrast"

// Reusable 27-key fixture builder. Phase 1 expanded ThemeColors to 27 keys
// (popover/popoverForeground/input + 8 sidebar* + the original 16).
function buildTokens(overrides: Partial<ThemeColors> = {}): ThemeColors {
  return {
    background: "#ffffff",
    foreground: "#0f172a",
    primary: "#3b82f6",
    primaryForeground: "#ffffff",
    secondary: "#64748b",
    secondaryForeground: "#ffffff",
    accent: "#3b82f6",
    accentForeground: "#ffffff",
    muted: "#f1f5f9",
    mutedForeground: "#64748b",
    card: "#ffffff",
    cardForeground: "#0f172a",
    popover: "#ffffff",
    popoverForeground: "#0f172a",
    input: "#e2e8f0",
    border: "#e2e8f0",
    ring: "#3b82f6",
    destructive: "#ef4444",
    destructiveForeground: "#ffffff",
    sidebar: "#f8fafc",
    sidebarForeground: "#0f172a",
    sidebarPrimary: "#3b82f6",
    sidebarPrimaryForeground: "#ffffff",
    sidebarAccent: "#f1f5f9",
    sidebarAccentForeground: "#0f172a",
    sidebarBorder: "#e2e8f0",
    sidebarRing: "#3b82f6",
    ...overrides,
  } as ThemeColors
}

describe("deriveTokenColor (single token)", () => {
  it("flips lightness for neutral colors (white -> near-black)", () => {
    const dark = deriveTokenColor("#ffffff", "light", "dark")
    expect(dark.startsWith("oklch(")).toBe(true)
    // White has L=1; flipped to L=0 produces a near-black; format: "oklch(0% ...)" or similar.
    // Just assert the lightness is below 0.2.
    const m = dark.match(/oklch\(([0-9.]+%?)/)
    expect(m).not.toBeNull()
    const raw = m![1]
    const l = parseFloat(raw) / (raw.includes("%") ? 100 : 1)
    expect(l).toBeLessThan(0.2)
  })

  it("preserves hue for accent colors", () => {
    // #3b82f6 is blue (hue ~250-270 in OKLCH).
    const dark = deriveTokenColor("#3b82f6", "light", "dark")
    const m = dark.match(/oklch\([^)]+ ([0-9.]+)\)/)
    expect(m).not.toBeNull()
    const hue = parseFloat(m![1])
    expect(hue).toBeGreaterThan(240)
    expect(hue).toBeLessThan(280)
  })

  it("attenuates chroma in dark mode for saturated colors", () => {
    const dark = deriveTokenColor("#ff0000", "light", "dark")
    const m = dark.match(/oklch\([0-9.%]+ ([0-9.]+)/)
    expect(m).not.toBeNull()
    const c = parseFloat(m![1])
    // Original chroma ~0.25 for pure red; derived should be slightly less (×0.92).
    expect(c).toBeLessThan(0.25)
    expect(c).toBeGreaterThan(0.18)
  })

  it("returns input unchanged when source and target variants match", () => {
    expect(deriveTokenColor("#3b82f6", "dark", "dark")).toBe("#3b82f6")
    expect(deriveTokenColor("#3b82f6", "light", "light")).toBe("#3b82f6")
  })

  it("returns input unchanged when culori cannot parse", () => {
    expect(deriveTokenColor("not-a-color", "light", "dark")).toBe("not-a-color")
  })
})

describe("deriveOppositeVariant (whole palette)", () => {
  it("returns a palette with all 27 keys", () => {
    const seed = buildTokens()
    const derived = deriveOppositeVariant(seed, "light")
    for (const key of Object.keys(seed) as Array<keyof ThemeColors>) {
      expect(derived[key]).toBeDefined()
      expect(derived[key].length).toBeGreaterThan(0)
    }
  })

  it("derived foreground/background pair has WCAG >= 4.5:1 contrast", () => {
    // Start with a high-contrast light palette; derive dark; verify contrast preserved.
    const seed = buildTokens({ background: "#ffffff", foreground: "#0f172a" })
    const dark = deriveOppositeVariant(seed, "light")
    expect(wcagContrast(dark.foreground, dark.background)).toBeGreaterThanOrEqual(4.5)
  })

  it("derived from dark seed produces a light palette (background lightness > 0.5)", () => {
    const darkSeed = buildTokens({ background: "#0b1220", foreground: "#f1f5f9" })
    const light = deriveOppositeVariant(darkSeed, "dark")
    const m = light.background.match(/oklch\(([0-9.]+%?)/)
    expect(m).not.toBeNull()
    const raw = m![1]
    const l = parseFloat(raw) / (raw.includes("%") ? 100 : 1)
    expect(l).toBeGreaterThan(0.5)
  })
})
