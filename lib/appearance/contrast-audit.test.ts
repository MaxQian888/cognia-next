import { auditThemeContrast, isFlaggedPair } from "./contrast-audit"
import type { ThemeColors } from "@/types/plugin/plugin-extended"

// Tokens chosen so every critical pair clears WCAG AA (4.5:1) by default.
// Tailwind's mid-blue/red brand colors fail AA against white, so we use
// the darker -700/-800 shades for the primary/destructive/accent surfaces
// and a slate-700 muted foreground.
function buildTokens(overrides: Partial<ThemeColors> = {}): ThemeColors {
  return {
    background: "#ffffff",
    foreground: "#0f172a",
    primary: "#1d4ed8",
    primaryForeground: "#ffffff",
    secondary: "#475569",
    secondaryForeground: "#ffffff",
    accent: "#1d4ed8",
    accentForeground: "#ffffff",
    muted: "#f1f5f9",
    mutedForeground: "#334155",
    card: "#ffffff",
    cardForeground: "#0f172a",
    popover: "#ffffff",
    popoverForeground: "#0f172a",
    input: "#e2e8f0",
    border: "#e2e8f0",
    ring: "#1d4ed8",
    destructive: "#b91c1c",
    destructiveForeground: "#ffffff",
    sidebar: "#f8fafc",
    sidebarForeground: "#0f172a",
    sidebarPrimary: "#1d4ed8",
    sidebarPrimaryForeground: "#ffffff",
    sidebarAccent: "#f1f5f9",
    sidebarAccentForeground: "#0f172a",
    sidebarBorder: "#e2e8f0",
    sidebarRing: "#1d4ed8",
    ...overrides,
  } as ThemeColors
}

describe("auditThemeContrast", () => {
  it("returns no failures for a well-formed light palette", () => {
    const audit = auditThemeContrast(buildTokens())
    expect(audit.failureCount).toBe(0)
    expect(audit.totalPairs).toBe(8)
  })

  it("flags low-contrast foreground/background pair", () => {
    const audit = auditThemeContrast(buildTokens({ foreground: "#aaaaaa", background: "#bbbbbb" }))
    expect(
      audit.failures.some((f) => f.pair[0] === "foreground" && f.pair[1] === "background")
    ).toBe(true)
    expect(audit.failureCount).toBeGreaterThanOrEqual(1)
  })

  it("flags multiple failures independently", () => {
    const audit = auditThemeContrast(
      buildTokens({
        primary: "#888888",
        primaryForeground: "#aaaaaa",
        sidebar: "#f8f8f8",
        sidebarForeground: "#dddddd",
      })
    )
    expect(audit.failureCount).toBeGreaterThanOrEqual(2)
  })
})

describe("isFlaggedPair", () => {
  it("returns true for either side of a flagged pair", () => {
    const audit = auditThemeContrast(
      buildTokens({ primary: "#888888", primaryForeground: "#aaaaaa" })
    )
    expect(isFlaggedPair(audit, "primary")).toBe(true)
    expect(isFlaggedPair(audit, "primaryForeground")).toBe(true)
  })

  it("returns false for unrelated keys", () => {
    const audit = auditThemeContrast(
      buildTokens({ primary: "#888888", primaryForeground: "#aaaaaa" })
    )
    expect(isFlaggedPair(audit, "background")).toBe(false)
  })
})
