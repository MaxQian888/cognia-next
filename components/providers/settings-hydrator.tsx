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
 * mirrors a 4-colour snapshot to `localStorage["cognia.appearance.mirror"]`
 * so the next cold-start's inline boot script (see `lib/appearance/boot-script.ts`)
 * can re-apply those vars before React hydrates, eliminating the FOUC flash
 * when a custom theme is active.
 */
export function SettingsHydrator(): null {
  const { resolvedTheme } = useTheme()
  const colorTheme = useSettingsStore((s) => s.colorTheme)
  const activeCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const customThemes = useSettingsStore((s) => s.customThemes)

  useEffect(() => {
    void useSettingsStore.getState().load()
  }, [])

  // Persist the mirror snapshot whenever the visible appearance fields
  // change. Driven by React's render cycle rather than a Zustand `subscribe`
  // so the snapshot stays in lockstep with what the appliers are painting
  // right now (which is what the boot script needs to replay on next launch).
  useEffect(() => {
    if (typeof window === "undefined") return
    if (!resolvedTheme) return

    // The boot mirror exists to pre-paint a *custom / preset* theme's shell
    // colors before hydration. The default preset is fully described by the
    // globals.css :root/.dark rules, so mirroring it would (a) paint the
    // lib/themes "default" shell palette over the canonical stylesheet and
    // (b) — since the inline boot vars never refresh on a runtime switch —
    // leave a stale dark tint bleeding into light mode. Skip and clear the
    // mirror for the default base so cold boot paints nothing; CustomThemeApplier
    // likewise drops any inline vars, making the switch a pure-CSS, flicker-free
    // class toggle.
    if (colorTheme === "default" && !activeCustomThemeId) {
      clearBootMirror()
      return
    }

    const variant: "light" | "dark" = resolvedTheme === "dark" ? "dark" : "light"
    const shellColors = getShellColors({ colorTheme, activeCustomThemeId, customThemes }, variant)
    const resolved = resolveActiveThemeColors({
      colorTheme,
      resolvedTheme: variant,
      activeCustomThemeId,
      customThemes,
    })

    const payload: BootMirrorPayload = {
      "--background": shellColors.backgroundHex,
      "--foreground": shellColors.foregroundHex,
      "--primary": resolved.colors.primary,
      "--accent": resolved.colors.accent,
    }
    writeBootMirror(payload)
  }, [resolvedTheme, colorTheme, activeCustomThemeId, customThemes])

  return null
}
