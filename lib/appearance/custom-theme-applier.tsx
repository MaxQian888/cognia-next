"use client"

import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { useSettingsStore } from "@/stores/settings"
import { resolveActiveThemeColors } from "@/lib/themes"
import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { themeKeyToCssVar, CSS_VAR_KEYS } from "./css-var"

/**
 * Mounts at the root layout and writes resolved theme tokens onto `<html>`
 * as inline CSS variables. Covers both custom themes AND color presets —
 * `resolveActiveThemeColors` always returns the correct palette, so we apply
 * it unconditionally. When the resolved colors match the default preset we
 * clear the inline vars so the `:root` / `.dark` stylesheet rules serve as
 * the single source of truth (avoids redundancy and keeps the cascade clean).
 *
 * Subscribes minimally — only the active id, the customThemes list, the
 * colorTheme preset, and the resolved theme — so unrelated settings updates
 * don't re-render this.
 */
export function CustomThemeApplier(): null {
  const activeCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const customThemes = useSettingsStore((s) => s.customThemes)
  const colorTheme = useSettingsStore((s) => s.colorTheme)
  const { resolvedTheme } = useTheme()
  const lastApplied = useRef(false)

  useEffect(() => {
    if (typeof document === "undefined") return
    if (!resolvedTheme) return // next-themes still hydrating; effect will re-run when settled
    const root = document.documentElement
    const variant: "light" | "dark" = resolvedTheme === "light" ? "light" : "dark"
    const resolved = resolveActiveThemeColors({
      colorTheme,
      resolvedTheme: variant,
      activeCustomThemeId,
      customThemes,
    })
    const isDefaultPreset = resolved.themeSource === "preset" && colorTheme === "default"
    if (isDefaultPreset) {
      if (lastApplied.current) {
        for (const cssVar of CSS_VAR_KEYS) root.style.removeProperty(cssVar)
        lastApplied.current = false
      }
      return
    }
    applyTokens(root, resolved.colors)
    lastApplied.current = true
  }, [activeCustomThemeId, customThemes, colorTheme, resolvedTheme])

  return null
}

function applyTokens(root: HTMLElement, tokens: ThemeColors): void {
  for (const [key, value] of Object.entries(tokens)) {
    if (!value) continue
    root.style.setProperty(themeKeyToCssVar(key), value)
  }
}
