"use client"

// The live theme accent, for the cursor's `"accent"` color mode.
//
// Reading `getComputedStyle(html).--primary` would look simpler but is wrong
// here: the value is written by `CustomThemeApplier` in an effect, so a read
// during the same commit sees the *previous* theme, and nothing re-runs when it
// changes. Resolving from the same store inputs the applier itself consumes
// gives a value that is correct on the first render after a theme switch.

import { useTheme } from "next-themes"
import { useSettingsStore } from "@/stores/settings"
import { resolveAppPalette } from "../resolve-app-palette"

/**
 * The resolved `primary` color of the active theme, or `undefined` while
 * next-themes is still deciding light vs dark (callers fall back to the pack
 * palette for that one frame rather than flashing a wrong-hue cursor).
 */
export function useCursorAccentColor(): string | undefined {
  const activeCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const accentColor = useSettingsStore((s) => s.accentColor)
  const customThemes = useSettingsStore((s) => s.customThemes)
  const colorTheme = useSettingsStore((s) => s.colorTheme)
  const a11y = useSettingsStore((s) => s.settings?.a11y)
  const { resolvedTheme } = useTheme()

  if (!resolvedTheme) return undefined

  return resolveAppPalette({
    colorTheme,
    resolvedTheme: resolvedTheme === "light" ? "light" : "dark",
    activeCustomThemeId,
    customThemes,
    accentColor,
    a11y,
  }).colors.primary
}
