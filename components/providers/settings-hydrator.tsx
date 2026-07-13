"use client"

import { useEffect } from "react"
import { useTheme } from "next-themes"
import { useSettingsStore } from "@/stores/settings"
import {
  clearBootMirror,
  writeBootMirror,
  type BootMirrorPayload,
} from "@/lib/appearance/boot-script"
import { getShellColors } from "@/lib/appearance/shell-sync"
import { resolveActiveThemeColors } from "@/lib/themes"
import { resolveRadiusVar } from "@/lib/appearance/radius-applier"
import { resolveTypographyVars } from "@/lib/appearance/typography-applier"
import { DEFAULT_DENSITY } from "@/types/appearance"

/**
 * Mounts at the root layout and triggers `useSettingsStore.load()` exactly
 * once. Without this hook the store stays at `{ loaded: false, settings: null }`
 * forever, which makes `SettingsSyncProvider` early-return and the user sees
 * defaults regardless of what's persisted in Dexie.
 *
 * `load()` itself is idempotent (early-returns when `loaded`), so re-mounts
 * during dev/HMR don't trigger duplicate Dexie reads.
 *
 * Additionally subscribes to appearance-relevant slices of the store and
 * mirrors a snapshot to `localStorage["cognia.appearance.mirror"]` so the next
 * cold-start's inline boot script (see `lib/appearance/boot-script.ts`) can
 * re-apply those vars/attrs before React hydrates, eliminating the FOUC flash.
 * Beyond the four shell colors, the mirror now carries the other
 * `<html>`-level knobs — corner radius, typography, and density — so a
 * non-default layout no longer flashes its default spacing / radius / font on
 * a cold boot. (Wallpaper lives on `<body>`, which the head script can't
 * touch, so it stays out of the mirror.)
 */
export function SettingsHydrator(): null {
  const { resolvedTheme } = useTheme()
  const colorTheme = useSettingsStore((s) => s.colorTheme)
  const activeCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const activePluginThemeId = useSettingsStore((s) => s.activePluginThemeId)
  const accentColor = useSettingsStore((s) => s.accentColor)
  const customThemes = useSettingsStore((s) => s.customThemes)
  const radius = useSettingsStore((s) => s.settings?.radius)
  const typography = useSettingsStore((s) => s.settings?.typographyExt)
  const density = useSettingsStore((s) => s.settings?.density)

  useEffect(() => {
    void useSettingsStore.getState().load()
  }, [])

  // Persist the mirror snapshot whenever the visible appearance fields change.
  // Driven by React's render cycle rather than a Zustand `subscribe` so the
  // snapshot stays in lockstep with what the appliers are painting right now.
  useEffect(() => {
    if (typeof window === "undefined") return
    if (!resolvedTheme) return

    const variant: "light" | "dark" = resolvedTheme === "dark" ? "dark" : "light"
    const payload: BootMirrorPayload = {}
    const vars: Record<string, string> = {}
    const attrs: Record<string, string> = {}

    // Shell colors — mirror only when they diverge from the globals.css
    // :root/.dark rules (a custom theme, non-default preset, or accent
    // override). The default preset defers to the stylesheet, and a live
    // plugin theme is painted from a <style> block whose colors this pure
    // helper can't resolve — so we skip both and let CustomThemeApplier /
    // PluginThemeApplier settle them a frame later without a stale bleed.
    const skipColors =
      activePluginThemeId != null ||
      (colorTheme === "default" && !activeCustomThemeId && !accentColor)
    if (!skipColors) {
      const shellColors = getShellColors(
        { colorTheme, activeCustomThemeId, customThemes, accentColor },
        variant
      )
      const resolved = resolveActiveThemeColors({
        colorTheme,
        resolvedTheme: variant,
        activeCustomThemeId,
        customThemes,
        accentColor,
      })
      payload["--background"] = shellColors.backgroundHex
      payload["--foreground"] = shellColors.foregroundHex
      payload["--primary"] = resolved.colors.primary
      payload["--accent"] = resolved.colors.accent
    }

    // Corner radius — only when non-default (resolver returns null at default).
    const radiusVar = resolveRadiusVar(radius)
    if (radiusVar) vars["--radius"] = radiusVar

    // Typography — include only the vars that differ from the defaults so a
    // pristine user keeps an empty mirror.
    const typoVars = resolveTypographyVars(typography)
    const defaultTypoVars = resolveTypographyVars(undefined)
    for (const key of Object.keys(typoVars)) {
      if (typoVars[key] !== defaultTypoVars[key]) vars[key] = typoVars[key]
    }

    // Density — mirror the global level when it isn't the default.
    if (density?.global && density.global !== DEFAULT_DENSITY.global) {
      attrs["data-density"] = density.global
    }

    if (Object.keys(vars).length > 0) payload.vars = vars
    if (Object.keys(attrs).length > 0) payload.attrs = attrs

    // Nothing to pre-paint (default colors + default layout) → drop the mirror
    // so cold boot paints nothing and the switch stays a pure-CSS class toggle.
    const hasColors = payload["--background"] !== undefined
    if (!hasColors && !payload.vars && !payload.attrs) {
      clearBootMirror()
      return
    }
    writeBootMirror(payload)
  }, [
    resolvedTheme,
    colorTheme,
    activeCustomThemeId,
    activePluginThemeId,
    accentColor,
    customThemes,
    radius,
    typography,
    density,
  ])

  return null
}
