// High-contrast theme presets targeting WCAG AAA (≥ 7:1) for normal text on
// every critical surface pair. Light = near-pure white background with
// near-black text; dark = inverted. A single deep-blue accent provides the
// only chroma — every other token is grayscale so contrast is unambiguous.
//
// Designed as a static override, not a generated palette: regenerated
// presets would risk drift below the AAA threshold. The token shape mirrors
// `ThemeColors` exactly so the result can be merged into the normal apply
// path with no special-casing in `CustomThemeApplier`.

import type { ThemeColors } from "@/types/plugin/plugin-extended"
import type { HighContrastMode } from "@/types/appearance"

export const HIGH_CONTRAST_LIGHT: ThemeColors = {
  background: "oklch(1 0 0)",
  foreground: "oklch(0.05 0 0)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.05 0 0)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.05 0 0)",
  primary: "oklch(0.18 0.13 264)",
  primaryForeground: "oklch(1 0 0)",
  secondary: "oklch(0.95 0 0)",
  secondaryForeground: "oklch(0.05 0 0)",
  accent: "oklch(0.18 0.13 264)",
  accentForeground: "oklch(1 0 0)",
  muted: "oklch(0.95 0 0)",
  mutedForeground: "oklch(0.25 0 0)",
  destructive: "oklch(0.4 0.22 27)",
  destructiveForeground: "oklch(1 0 0)",
  border: "oklch(0.55 0 0)",
  input: "oklch(0.45 0 0)",
  ring: "oklch(0.25 0.13 264)",
  sidebar: "oklch(0.97 0 0)",
  sidebarForeground: "oklch(0.05 0 0)",
  sidebarPrimary: "oklch(0.18 0.13 264)",
  sidebarPrimaryForeground: "oklch(1 0 0)",
  sidebarAccent: "oklch(0.9 0 0)",
  sidebarAccentForeground: "oklch(0.05 0 0)",
  sidebarBorder: "oklch(0.55 0 0)",
  sidebarRing: "oklch(0.25 0.13 264)",
}

export const HIGH_CONTRAST_DARK: ThemeColors = {
  background: "oklch(0 0 0)",
  foreground: "oklch(1 0 0)",
  card: "oklch(0.1 0 0)",
  cardForeground: "oklch(1 0 0)",
  popover: "oklch(0.1 0 0)",
  popoverForeground: "oklch(1 0 0)",
  primary: "oklch(0.85 0.18 264)",
  primaryForeground: "oklch(0.05 0 0)",
  secondary: "oklch(0.18 0 0)",
  secondaryForeground: "oklch(1 0 0)",
  accent: "oklch(0.85 0.18 264)",
  accentForeground: "oklch(0.05 0 0)",
  muted: "oklch(0.15 0 0)",
  mutedForeground: "oklch(0.85 0 0)",
  destructive: "oklch(0.7 0.22 27)",
  destructiveForeground: "oklch(0.05 0 0)",
  border: "oklch(0.5 0 0)",
  input: "oklch(0.55 0 0)",
  ring: "oklch(0.85 0.18 264)",
  sidebar: "oklch(0.08 0 0)",
  sidebarForeground: "oklch(1 0 0)",
  sidebarPrimary: "oklch(0.85 0.18 264)",
  sidebarPrimaryForeground: "oklch(0.05 0 0)",
  sidebarAccent: "oklch(0.2 0 0)",
  sidebarAccentForeground: "oklch(1 0 0)",
  sidebarBorder: "oklch(0.5 0 0)",
  sidebarRing: "oklch(0.85 0.18 264)",
}

/**
 * Returns the high-contrast token override for the given mode, or null when
 * disabled. The returned object is a fresh copy each call so the caller may
 * mutate.
 */
export function highContrastOverride(mode: HighContrastMode): ThemeColors | null {
  if (mode === "off") return null
  return mode === "light" ? { ...HIGH_CONTRAST_LIGHT } : { ...HIGH_CONTRAST_DARK }
}
