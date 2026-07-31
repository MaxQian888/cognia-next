// Synthesise a 3-swatch icon and a CSS-gradient string from a ThemeColors
// palette. Used by the appearance Theme tab to render preset cards
// uniformly regardless of source (built-in / imported / plugin).
//
// Pure module: no React, no DOM, no allocations beyond what the caller
// destructures. Easy to test.

import type { ThemeColors } from "@/types/plugin/plugin"

export interface ThemeIconSwatches {
  background: string
  primary: string
  accent: string
}

const FALLBACK = "#6b7280" // neutral grey — last-resort visible swatch.

/**
 * Pick three representative colors from a `ThemeColors` palette. Falls back
 * along the chain `accent → primary → foreground → background → neutral grey`
 * when the requested key isn't set, so cards always render *something*.
 */
export function synthesizeThemeSwatches(
  colors: Partial<ThemeColors> | undefined
): ThemeIconSwatches {
  const c = colors ?? {}
  const background = c.background || c.card || c.popover || FALLBACK
  const primary = c.primary || c.foreground || background
  const accent = c.accent || c.primary || c.foreground || background
  return { background, primary, accent }
}

/**
 * Build a 135° linear gradient that runs through all three swatches. Suitable
 * as a `style.background` value for hero swatches or list row dots.
 */
export function synthesizeThemeGradient(colors: Partial<ThemeColors> | undefined): string {
  const { background, primary, accent } = synthesizeThemeSwatches(colors)
  return `linear-gradient(135deg, ${background} 0%, ${primary} 50%, ${accent} 100%)`
}
