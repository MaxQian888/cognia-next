/**
 * Cycle through the theme's chart-1..5 colors for categorical series (donut
 * slices, bar categories). Resolved colors come from `useThemeColors` so they
 * track light/dark mode.
 */

import type { ThemeColors } from "@/hooks/logging/use-theme-colors"

const PALETTE_KEYS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const

export function paletteColor(colors: ThemeColors, index: number): string {
  const key =
    PALETTE_KEYS[((index % PALETTE_KEYS.length) + PALETTE_KEYS.length) % PALETTE_KEYS.length]
  return colors[key]
}
