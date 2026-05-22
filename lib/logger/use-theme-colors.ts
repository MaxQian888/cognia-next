/**
 * useThemeColors — resolve theme CSS variables to live oklch strings.
 *
 * Recharts renders `<path fill={...}>` as an SVG presentation attribute,
 * which doesn't resolve `var(--token)`. So for raw Recharts (no
 * <ChartContainer> wrapper) we have to inline the actual color value.
 *
 * Delegates to `@/lib/appearance/use-theme-css-vars` so this hook and the
 * A2UI rich-output components share a single live-reader (and so the
 * inline-style bug — the original observer only watched `class`, not
 * `style` — is fixed in one place).
 *
 * SSR-safe: returns the static :root defaults on the server / first paint,
 * then upgrades to the live oklch values on mount. Defaults mirror the
 * light-mode values in app/globals.css so charts render with reasonable
 * colors before hydration completes.
 */

"use client"

import { useMemo } from "react"
import { useThemeCssVars } from "@/lib/appearance/use-theme-css-vars"
import type { ThemeColorKey } from "./level-theme"

const THEME_KEYS: readonly ThemeColorKey[] = [
  "success",
  "warning",
  "destructive",
  "muted-foreground",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
] as const

const DEFAULT_COLORS: Record<ThemeColorKey, string> = {
  success: "oklch(0.62 0.17 145)",
  warning: "oklch(0.75 0.17 80)",
  destructive: "oklch(0.577 0.245 27.325)",
  "muted-foreground": "oklch(0.556 0 0)",
  "chart-1": "oklch(0.646 0.222 41.116)",
  "chart-2": "oklch(0.6 0.118 184.704)",
  "chart-3": "oklch(0.398 0.07 227.392)",
  "chart-4": "oklch(0.828 0.189 84.429)",
  "chart-5": "oklch(0.769 0.188 70.08)",
}

// Pre-prefix to `--theme-key` so the generic hook can read them directly.
// Stable module-level constants — no per-render allocation.
const VAR_KEYS: readonly string[] = THEME_KEYS.map((key) => `--${key}`)
const VAR_DEFAULTS: Record<string, string> = Object.fromEntries(
  THEME_KEYS.map((key) => [`--${key}`, DEFAULT_COLORS[key]])
)

export type ThemeColors = Record<ThemeColorKey, string>

export function useThemeColors(): ThemeColors {
  const raw = useThemeCssVars(VAR_KEYS, VAR_DEFAULTS)
  // Project the prefixed map back to the legacy non-prefixed shape so
  // existing call sites (level icons, Recharts paths) don't need to change.
  return useMemo(() => {
    const next = {} as ThemeColors
    for (const key of THEME_KEYS) {
      next[key] = raw[`--${key}`]
    }
    return next
  }, [raw])
}

export { DEFAULT_COLORS as DEFAULT_THEME_COLORS, THEME_KEYS }
