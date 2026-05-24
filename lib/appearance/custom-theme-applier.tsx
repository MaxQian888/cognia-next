"use client"

import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { useSettingsStore } from "@/stores/settings"
import { resolveActiveThemeColors } from "@/lib/themes"
import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { themeKeyToCssVar, CSS_VAR_KEYS, applyCssVars, removeCssVars } from "./css-var"
import { ensureForegroundContrast } from "./ensure-contrast"
import { highContrastOverride } from "./high-contrast-presets"
import {
  COLORBLIND_EXTRA_VAR_KEYS,
  colorblindCssVars,
  colorblindThemeOverrides,
} from "./colorblind-palettes"

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
  const a11y = useSettingsStore((s) => s.settings?.a11y)
  const { resolvedTheme } = useTheme()
  const lastApplied = useRef(false)
  const lastExtraVars = useRef<string[]>([])

  useEffect(() => {
    if (typeof document === "undefined") return
    if (!resolvedTheme) return // next-themes still hydrating; effect will re-run when settled
    const root = document.documentElement
    const variant: "light" | "dark" = resolvedTheme === "light" ? "light" : "dark"

    // v47 — a11y overrides win, but only when explicitly enabled. The
    // high-contrast preset replaces the entire ThemeColors object; the
    // colorblind layer then patches a few signal tokens and the categorical
    // chart/workflow CSS vars. Layering order:
    //   1. resolved base (preset / custom theme / VSCode import)
    //   2. high-contrast override (replaces ThemeColors when active)
    //   3. colorblind theme overrides (patches destructive + a few extras)
    //   4. colorblind CSS vars (chart-1..5 + --wf-*)
    const highContrast = a11y?.highContrast ?? "off"
    const colorblind = a11y?.colorblindMode ?? "off"

    let tokens: ThemeColors
    const hcOverride = highContrastOverride(highContrast)
    if (hcOverride) {
      tokens = hcOverride
    } else {
      const resolved = resolveActiveThemeColors({
        colorTheme,
        resolvedTheme: variant,
        activeCustomThemeId,
        customThemes,
      })
      tokens = resolved.colors
    }
    // Layer colorblind overrides on top of whichever base we landed on.
    const cbOverrides = colorblindThemeOverrides(colorblind)
    if (Object.keys(cbOverrides).length > 0) {
      tokens = { ...tokens, ...cbOverrides } as ThemeColors
    }

    // Decide whether the inline `:root` write is necessary. When there is
    // no a11y override AND the base resolved to the default preset for the
    // active variant, fall back to the stylesheet `:root`/`.dark` rule.
    const usingDefaultBase = !hcOverride && colorTheme === "default" && !activeCustomThemeId
    const usingExtras = Object.keys(cbOverrides).length > 0 || colorblind !== "off"

    if (usingDefaultBase && !usingExtras) {
      if (lastApplied.current) {
        for (const cssVar of CSS_VAR_KEYS) root.style.removeProperty(cssVar)
        lastApplied.current = false
      }
      // Also clear any prior categorical vars (e.g. user just turned cb off).
      if (lastExtraVars.current.length > 0) {
        removeCssVars(root, lastExtraVars.current)
        lastExtraVars.current = []
      }
      return
    }

    // Harden legibility before writing: any preset / custom / imported theme
    // whose foreground clashes with its surface (notably secondary buttons in
    // dark mode) gets its foreground nudged to WCAG AA. The default theme
    // short-circuits above and is governed by `globals.css`, so this only
    // touches inline-applied palettes.
    applyTokens(root, ensureForegroundContrast(tokens))
    lastApplied.current = true

    // Extra categorical vars (chart + wf) live outside ThemeColors.
    // Clear the previous set, then write the new one.
    if (lastExtraVars.current.length > 0) {
      removeCssVars(root, lastExtraVars.current)
      lastExtraVars.current = []
    }
    const extraVars = colorblindCssVars(colorblind)
    if (Object.keys(extraVars).length > 0) {
      lastExtraVars.current = applyCssVars(root, extraVars)
    }
  }, [activeCustomThemeId, customThemes, colorTheme, resolvedTheme, a11y])

  return null
}

function applyTokens(root: HTMLElement, tokens: ThemeColors): void {
  for (const [key, value] of Object.entries(tokens)) {
    if (!value) continue
    root.style.setProperty(themeKeyToCssVar(key), value)
  }
}

/** Exposed for tests so they can sanity-check the extra-var keys list. */
export const __INTERNALS__ = {
  COLORBLIND_EXTRA_VAR_KEYS,
}
