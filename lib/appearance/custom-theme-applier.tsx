"use client"

import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { useSettingsStore } from "@/stores/settings"
import { resolveActiveThemeColors } from "@/lib/themes"
import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { themeKeyToCssVar, CSS_VAR_KEYS } from "./css-var"

/**
 * Mounts at the root layout and writes the active CustomTheme's tokens onto
 * `<html>` as inline CSS variables. When no custom theme is active or none
 * resolves, removes all previously-injected variables so the cascade falls
 * back to the `:root` / `.dark` defaults in `app/globals.css`.
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
    const root = document.documentElement
    const variant: "light" | "dark" = resolvedTheme === "light" ? "light" : "dark"
    const resolved = resolveActiveThemeColors({
      colorTheme,
      resolvedTheme: variant,
      activeCustomThemeId,
      customThemes,
    })
    const isCustom = resolved.themeSource === "custom"
    if (!isCustom) {
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
