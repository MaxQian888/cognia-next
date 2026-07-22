"use client"

import { useEffect } from "react"
import { useTheme } from "next-themes"

import { codeServerClient } from "@/lib/codeserver/client"
import {
  buildCodeServerSettings,
  mergeCodeServerSettings,
} from "@/lib/codeserver/theme/build-settings"
import { isTauri } from "@/lib/tauri"
import { resolveActiveThemeColors } from "@/lib/themes"
import { useSettingsStore } from "@/stores"

/**
 * Keeps the embedded code-server painted in the app's active palette.
 *
 * Writes `workbench.colorCustomizations` into code-server's `settings.json`;
 * VS Code hot-watches that file, so a theme flip repaints the running workbench
 * with no reload and no lost editor state. Same palette source as the Monaco
 * surfaces ({@link resolveActiveThemeColors}), so both engines agree.
 *
 * Runs whenever `enabled` and re-runs on every palette input, including custom
 * themes edited in Settings → Appearance.
 */
export function useCodeServerThemeSync(enabled: boolean): void {
  const { resolvedTheme } = useTheme()
  const colorTheme = useSettingsStore((s) => s.colorTheme)
  const activeCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const customThemes = useSettingsStore((s) => s.customThemes)

  useEffect(() => {
    if (!enabled || !isTauri() || !resolvedTheme) return
    let cancelled = false
    void (async () => {
      const variant: "light" | "dark" = resolvedTheme === "dark" ? "dark" : "light"
      const resolved = resolveActiveThemeColors({
        colorTheme,
        resolvedTheme: variant,
        activeCustomThemeId,
        customThemes,
      })
      const managed = buildCodeServerSettings({ colors: resolved.colors, variant })
      // Read-merge-write so anything the user set from inside VS Code survives.
      const existing = await codeServerClient.readUserSettings().catch(() => "")
      if (cancelled) return
      await codeServerClient
        .writeUserSettings(mergeCodeServerSettings(existing, managed))
        // A theming failure must never take the editor down with it.
        .catch(() => undefined)
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, resolvedTheme, colorTheme, activeCustomThemeId, customThemes])
}
