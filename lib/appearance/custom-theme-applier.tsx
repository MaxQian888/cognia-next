"use client"

import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { useSettingsStore } from "@/stores/settings"
import type { ThemeColors } from "@/types/plugin/plugin"
import { themeKeyToCssVar, CSS_VAR_KEYS, applyCssVars, removeCssVars } from "./css-var"
import { BOOT_MIRROR_KEYS } from "./boot-script"
import { resolveAppPalette } from "./resolve-app-palette"
import { COLORBLIND_EXTRA_VAR_KEYS, colorblindCssVars } from "./colorblind-palettes"

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
  const activePluginThemeId = useSettingsStore((s) => s.activePluginThemeId)
  const accentColor = useSettingsStore((s) => s.accentColor)
  const customThemes = useSettingsStore((s) => s.customThemes)
  const colorTheme = useSettingsStore((s) => s.colorTheme)
  const a11y = useSettingsStore((s) => s.settings?.a11y)
  const { resolvedTheme } = useTheme()
  const lastApplied = useRef(false)
  const lastExtraVars = useRef<string[]>([])
  // Extra CSS vars carried by a cloned `cssVariables` plugin theme
  // (`CustomTheme.cssVars`), tracked separately so we can clear them cleanly
  // when the active theme changes or a plugin theme takes over.
  const cssVarsApplied = useRef<string[]>([])

  useEffect(() => {
    if (typeof document === "undefined") return
    if (!resolvedTheme) return // next-themes still hydrating; effect will re-run when settled
    const root = document.documentElement
    const variant: "light" | "dark" = resolvedTheme === "light" ? "light" : "dark"

    // A directly-activated plugin theme owns the cascade via a
    // `<style data-plugin-theme>` block (PluginThemeApplier). Inline `<html>`
    // custom properties out-specify a stylesheet `:root{}` rule, so we must
    // clear ours and stand down while a plugin theme is active. When it is
    // deactivated, this effect re-runs (activePluginThemeId dep) and repaints.
    if (activePluginThemeId) {
      if (lastApplied.current) {
        for (const cssVar of CSS_VAR_KEYS) root.style.removeProperty(cssVar)
        lastApplied.current = false
      }
      for (const key of BOOT_MIRROR_KEYS) {
        if (root.style.getPropertyValue(key)) root.style.removeProperty(key)
      }
      if (lastExtraVars.current.length > 0) {
        removeCssVars(root, lastExtraVars.current)
        lastExtraVars.current = []
      }
      // Clear the cloned-theme extra CSS vars too (see cssVarsApplied ref).
      if (cssVarsApplied.current.length > 0) {
        removeCssVars(root, cssVarsApplied.current)
        cssVarsApplied.current = []
      }
      return
    }

    // v47 — a11y overrides win, but only when explicitly enabled. The
    // high-contrast preset replaces the entire ThemeColors object; the
    // colorblind layer then patches a few signal tokens and the categorical
    // chart/workflow CSS vars. Layering order:
    //   1. resolved base (preset / custom theme / VSCode import)
    //   2. high-contrast override (replaces ThemeColors when active)
    //   3. colorblind theme overrides (patches destructive + a few extras)
    //   4. colorblind CSS vars (chart-1..5 + --wf-*)
    const colorblind = a11y?.colorblindMode ?? "off"

    // Steps 1-4 live in `resolveAppPalette` so the native shell and the embedded
    // Pro IDE resolve the palette exactly the way this applier does — they used
    // to each re-implement a subset and disagree with what the DOM showed. No
    // `pluginTheme` is passed: this applier stands down entirely while a plugin
    // theme owns the cascade (see the early return above).
    const resolved = resolveAppPalette({
      colorTheme,
      resolvedTheme: variant,
      activeCustomThemeId,
      customThemes,
      accentColor,
      a11y,
    })
    const tokens = resolved.colors
    const hcOverride = resolved.highContrast

    // Decide whether the inline `:root` write is necessary. When there is
    // no a11y override AND the base resolved to the default preset for the
    // active variant, fall back to the stylesheet `:root`/`.dark` rule.
    // An accent override retints the default preset, so it can no longer defer
    // to the globals.css :root/.dark rules — force the inline write path.
    const usingDefaultBase =
      !hcOverride && colorTheme === "default" && !activeCustomThemeId && !accentColor
    const usingExtras = colorblind !== "off"

    if (usingDefaultBase && !usingExtras) {
      if (lastApplied.current) {
        for (const cssVar of CSS_VAR_KEYS) root.style.removeProperty(cssVar)
        lastApplied.current = false
      }
      // The pre-hydration boot script (lib/appearance/boot-script.ts) paints a
      // 4-var shell snapshot (--background/--foreground/--primary/--accent)
      // inline on <html> to avoid a cold-boot flash. That snapshot reflects the
      // boot-time variant and is never refreshed on a runtime theme switch, so
      // for the default preset — already governed by the globals.css :root/.dark
      // rules — we must drop it. Otherwise the stale inline values keep
      // overriding the stylesheet after a switch (e.g. the dark shell background
      // bleeding into light mode); and because an inline var beats a class
      // toggle, the theme only "catches up" a frame later via this effect — the
      // flicker users report. React never wrote these (the boot script did), so
      // the `lastApplied` guard above doesn't cover them. Clearing them lets the
      // class toggle alone repaint the default theme synchronously, flicker-free.
      for (const key of BOOT_MIRROR_KEYS) {
        if (root.style.getPropertyValue(key)) root.style.removeProperty(key)
      }
      // Also clear any prior categorical vars (e.g. user just turned cb off).
      if (lastExtraVars.current.length > 0) {
        removeCssVars(root, lastExtraVars.current)
        lastExtraVars.current = []
      }
      if (cssVarsApplied.current.length > 0) {
        removeCssVars(root, cssVarsApplied.current)
        cssVarsApplied.current = []
      }
      return
    }

    // `tokens` is already contrast-hardened by `resolveAppPalette`: any preset /
    // custom / imported theme whose foreground clashes with its surface (notably
    // secondary buttons in dark mode) has had it nudged to WCAG AA. The default
    // theme short-circuits above and is governed by `globals.css`, so that only
    // ever touches inline-applied palettes.
    applyTokens(root, tokens)
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

    // A custom theme cloned from a `cssVariables` plugin theme carries the
    // author's extra `--*` overrides in `cssVars`. Apply them after the
    // structured tokens so the cloned theme renders identically to the
    // directly-activated plugin theme. Clear the previous set first.
    if (cssVarsApplied.current.length > 0) {
      removeCssVars(root, cssVarsApplied.current)
      cssVarsApplied.current = []
    }
    const activeRow = activeCustomThemeId
      ? customThemes.find((tm) => tm.id === activeCustomThemeId)
      : undefined
    if (activeRow?.cssVars && Object.keys(activeRow.cssVars).length > 0) {
      cssVarsApplied.current = applyCssVars(root, activeRow.cssVars)
    }
  }, [
    activeCustomThemeId,
    activePluginThemeId,
    accentColor,
    customThemes,
    colorTheme,
    resolvedTheme,
    a11y,
  ])

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
