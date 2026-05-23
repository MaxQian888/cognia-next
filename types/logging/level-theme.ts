/**
 * Level Theme Types (UI-side)
 *
 * Pure types for the level-theme tokens. The runtime LEVEL_THEME table and
 * ALL_LEVELS constant live in `lib/logging/level-theme.ts` so this file
 * stays free of lucide-react runtime imports.
 */

import type { LucideIcon } from "lucide-react"

export type ThemeColorKey =
  | "success"
  | "warning"
  | "destructive"
  | "muted-foreground"
  | "chart-1"
  | "chart-2"
  | "chart-3"
  | "chart-4"
  | "chart-5"

export interface LevelTheme {
  icon: LucideIcon
  /** Tailwind text color for the level icon. */
  iconColor: string
  /** Composite bg + text class for level badges. */
  badgeClass: string
  /** Left-border accent for log rows. */
  gutterClass: string
  /** Wallpaper-friendly tint for expanded rows / detail surfaces. */
  bgClass: string
  /** CSS custom property name (without `--` prefix) for Recharts SVG. */
  chartColor: ThemeColorKey
}
