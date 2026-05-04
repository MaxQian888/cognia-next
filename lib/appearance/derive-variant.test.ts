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
    // culori's formatCss emits oklch(L c h) with decimal lightness (not percent)
    const m = dark.match(/^oklch\(([0-9.]+)\s/)
    expect(m).not.toBeNull()
    const l = parseFloat(m![1])
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
    // culori's formatCss emits oklch(L c h) with decimal numbers separated by spaces.
    const m = dark.match(/^oklch\(([0-9.]+)\s+([0-9.]+)\s/)
    expect(m).not.toBeNull()
    const c = parseFloat(m![2])
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

  it("preserves WCAG >= 4.5 contrast for high-contrast seeds (paired bg/fg)", () => {
    // Strong starting contrast (ratio ~21) survives the lightness flip.
    const seed = buildTokens({ background: "#ffffff", foreground: "#0f172a" })
    const dark = deriveOppositeVariant(seed, "light")
    expect(wcagContrast(dark.foreground, dark.background)).toBeGreaterThanOrEqual(4.5)
  })

  it("can drop below WCAG AA for low-contrast seeds — known limitation, Task 13 enforceReadable will fix", () => {
    // Real-world muted seed; derived pair has ratio ~4.4, below 4.5.
    const seed = buildTokens({ background: "#f8fafc", foreground: "#475569" })
    const dark = deriveOppositeVariant(seed, "light")
    const ratio = wcagContrast(dark.foreground, dark.background)
    // Document the actual behavior so Task 13 can detect when this is fixed.
    expect(ratio).toBeLessThan(4.5)
    expect(ratio).toBeGreaterThan(3) // still readable as warn-level, just not AA
  })

  it("derived from dark seed produces a light palette (background lightness > 0.5)", () => {
    const darkSeed = buildTokens({ background: "#0b1220", foreground: "#f1f5f9" })
    const light = deriveOppositeVariant(darkSeed, "dark")
    const m = light.background.match(/^oklch\(([0-9.]+)\s/)
    expect(m).not.toBeNull()
    expect(parseFloat(m![1])).toBeGreaterThan(0.5)
  })
})

describe("deriveTokenColor (edge cases)", () => {
  it("strips alpha from rrggbbaa input and returns valid oklch", () => {
    // Alpha is dropped because culori's parser ignores it for opaque conversion.
    // The output should be a valid oklch() string.
    const result = deriveTokenColor("#ff000080", "light", "dark")
    expect(result.startsWith("oklch(")).toBe(true)
  })

  it("accepts oklch() input directly", () => {
    const result = deriveTokenColor("oklch(0.5 0.1 250)", "light", "dark")
    expect(result.startsWith("oklch(")).toBe(true)
  })

  it("accepts named colors (red)", () => {
    const result = deriveTokenColor("red", "light", "dark")
    expect(result.startsWith("oklch(")).toBe(true)
  })

  it("triple-flip is NOT idempotent due to dark-mode chroma attenuation", () => {
    // Document the deliberate non-idempotency so future maintainers don't
    // try to "fix" it.
    const start = "#3b82f6"
    const dark = deriveTokenColor(start, "light", "dark")
    const light = deriveTokenColor(dark, "dark", "light")
    const dark2 = deriveTokenColor(light, "light", "dark")
    // Chroma drifts on each dark-mode pass via DARK_CHROMA_ATTENUATION.
    expect(dark).not.toBe(dark2)
  })
})
