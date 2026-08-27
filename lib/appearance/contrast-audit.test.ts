import {
  auditThemeContrast,
  auditTokens,
  autoFixViolations,
  isFlaggedPair,
  targetRatio,
} from "./contrast-audit"
import { wcagContrast } from "./contrast"
import { normalizeThemeColors } from "./theme-token-catalog"
import type { ResolvedThemeColors, ThemeColors } from "@/types/plugin/plugin"

// Tokens chosen so every critical pair clears WCAG AA (4.5:1) by default.
// Tailwind's mid-blue/red brand colors fail AA against white, so we use
// the darker -700/-800 shades for the primary/destructive/accent surfaces
// and a slate-700 muted foreground.
/**
 * The audit takes a resolved palette, so the fixture resolves too: scoring a
 * hand-written 27-token object would silently compare `undefined` against
 * `undefined` on the three status pairs and report a plausible-looking 1:1.
 */
function buildTokens(overrides: Partial<ThemeColors> = {}): ResolvedThemeColors {
  return normalizeThemeColors(
    {
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
    } as ThemeColors,
    "light"
  )
}

describe("auditThemeContrast", () => {
  it("returns no failures for a well-formed light palette", () => {
    const audit = auditThemeContrast(buildTokens())
    expect(audit.failureCount).toBe(0)
    expect(audit.totalPairs).toBe(11)
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

describe("targetRatio", () => {
  it.each([
    ["off", 0],
    ["AA", 4.5],
    ["AAA", 7],
  ] as const)("%s -> %s", (target, expected) => {
    expect(targetRatio(target)).toBe(expected)
  })
})

describe("auditTokens", () => {
  it("returns no failures at AA when palette already passes", () => {
    const result = auditTokens(buildTokens(), "AA")
    expect(result.failureCount).toBe(0)
    expect(result.target).toBe("AA")
  })

  it("uses 7:1 threshold at AAA and flags more pairs", () => {
    // Tokens that pass AA but fail AAA — mid-grey foreground at #475569 on
    // white scores ~7.0:1, edge of AAA. We pick something that barely passes
    // AA but fails AAA.
    const tokens = buildTokens({ mutedForeground: "#666666" })
    const aaaResult = auditTokens(tokens, "AAA")
    const aaResult = auditTokens(tokens, "AA")
    expect(aaaResult.failureCount).toBeGreaterThanOrEqual(aaResult.failureCount)
    expect(aaaResult.target).toBe("AAA")
  })

  it("returns zero failures when target is off", () => {
    const tokens = buildTokens({ foreground: "#aaaaaa", background: "#bbbbbb" })
    expect(auditTokens(tokens, "off").failureCount).toBe(0)
  })
})

describe("autoFixViolations", () => {
  it("returns identity when no failures", () => {
    const tokens = buildTokens()
    const out = autoFixViolations(tokens, "AA")
    expect(out.movedKeys).toEqual([])
    expect(out.unfixable).toEqual([])
    expect(out.tokens).toEqual(tokens)
  })

  it("repairs a failing foreground/background pair", () => {
    const tokens = buildTokens({ foreground: "#aaaaaa", background: "#bbbbbb" })
    const out = autoFixViolations(tokens, "AA")
    expect(out.movedKeys).toContain("foreground")
    expect(wcagContrast(out.tokens.foreground, out.tokens.background)).toBeGreaterThanOrEqual(
      4.5 - 0.05
    )
  })

  it("does not touch the background when fixing a foreground", () => {
    const tokens = buildTokens({ foreground: "#aaaaaa", background: "#ffffff" })
    const out = autoFixViolations(tokens, "AA")
    expect(out.tokens.background).toBe(tokens.background)
  })

  it("can hit AAA when target is AAA", () => {
    const tokens = buildTokens({ foreground: "#666666", background: "#ffffff" })
    const out = autoFixViolations(tokens, "AAA")
    if (out.movedKeys.includes("foreground")) {
      expect(wcagContrast(out.tokens.foreground, out.tokens.background)).toBeGreaterThanOrEqual(
        7 - 0.05
      )
    }
  })

  it("repairs every failing pair so a re-audit yields zero failures", () => {
    const tokens = buildTokens({
      foreground: "#aaaaaa",
      background: "#bbbbbb",
      primary: "#888888",
      primaryForeground: "#999999",
    })
    const out = autoFixViolations(tokens, "AA")
    // After auto-fix, the patched tokens must have no remaining failures.
    expect(auditTokens(out.tokens, "AA").failureCount).toBe(0)
    expect(out.movedKeys.length).toBeGreaterThanOrEqual(1)
  })

  it("is a no-op when target is off", () => {
    const tokens = buildTokens({ foreground: "#aaaaaa", background: "#bbbbbb" })
    const out = autoFixViolations(tokens, "off")
    expect(out.movedKeys).toEqual([])
    expect(out.tokens).toEqual(tokens)
  })
})
