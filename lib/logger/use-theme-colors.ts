/**
 * useThemeColors — resolve theme CSS variables to live oklch strings.
 *
 * Recharts renders `<path fill={...}>` as an SVG presentation attribute,
 * which doesn't resolve `var(--token)`. So for raw Recharts (no
 * <ChartContainer> wrapper) we have to inline the actual color value.
 * This hook reads the variables from `document.documentElement` and
 * re-reads them whenever the `class` attribute on `<html>` changes
 * (i.e., when next-themes toggles between light and dark).
 *
 * SSR-safe: returns the static :root defaults on the server / first paint,
 * then upgrades to the live oklch values on mount. Defaults mirror the
 * light-mode values in app/globals.css so charts render with reasonable
 * colors before hydration completes.
 */

"use client"

import { useEffect, useState } from "react"
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

export type ThemeColors = Record<ThemeColorKey, string>

export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(DEFAULT_COLORS)

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return

    const root = document.documentElement

    const readColors = () => {
      const computed = getComputedStyle(root)
      const next = {} as ThemeColors
      for (const key of THEME_KEYS) {
        const value = computed.getPropertyValue(`--${key}`).trim()
        next[key] = value || DEFAULT_COLORS[key]
      }
      setColors(next)
    }

    readColors()

    const observer = new MutationObserver(readColors)
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })

    return () => observer.disconnect()
  }, [])

  return colors
}

export { DEFAULT_COLORS as DEFAULT_THEME_COLORS, THEME_KEYS }
