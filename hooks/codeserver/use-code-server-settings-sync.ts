"use client"

import { useEffect } from "react"
import { useSyncExternalStore } from "react"
import { useTheme } from "next-themes"

import { resolveAppPalette } from "@/lib/appearance/resolve-app-palette"
import { getShellColors } from "@/lib/appearance/shell-sync"
import { type CodeServerProfile, codeServerClient } from "@/lib/codeserver/client"
import { setCodeServerPaneBackground } from "@/lib/codeserver/pane-manager"
import {
  CODESERVER_THEME_SETTING_KEYS,
  buildCodeServerSettings,
  mergeCodeServerSettings,
} from "@/lib/codeserver/theme/build-settings"
import { isTauri } from "@/lib/tauri"
import { listPluginThemes, subscribeThemeRegistry } from "@/lib/theme/theme-registry"
import type { PluginTheme } from "@/lib/theme/theme-registry"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { useSettingsStore } from "@/stores"

/** Stable empty snapshot for SSR / pre-registration renders. */
const EMPTY_PLUGIN_THEMES: PluginTheme[] = []
function getServerPluginThemes(): PluginTheme[] {
  return EMPTY_PLUGIN_THEMES
}

/**
 * Keeps the embedded code-server painted and configured like the rest of cognia.
 *
 * Writes the app's palette (`workbench.colorCustomizations`) plus its editor,
 * motion and a11y preferences into code-server's `settings.json`. VS Code
 * hot-watches that file, so a theme flip or a preference change repaints /
 * reconfigures the running workbench with no reload and no lost editor state.
 *
 * Three properties make the result actually match the app, where the earlier
 * theme-only version did not:
 *
 *  - the palette comes from {@link resolveAppPalette}, the same resolver the DOM
 *    and the native shell use, so the accent override and all three a11y layers
 *    (high contrast, colorblind, contrast hardening) reach the editor;
 *  - the colour table is export-specific and covers the whole workbench chrome,
 *    not just the ~30 keys the importer's sampling table happened to mention;
 *  - the editor preferences come from the same `useCanvasSettingsStore` slice
 *    that drives Monaco, so the two engines behave alike rather than merely
 *    looking alike.
 *
 * Authority is the unified editor-link switch (`monacoLink`, Settings →
 * Appearance → Advanced), matching Monaco's own ladder: a11y high contrast wins
 * outright, then a pinned theme or a disabled link means "stop driving colours"
 * — the non-colour preferences still sync either way.
 *
 * Runs whenever `enabled` and re-runs on every input.
 *
 * `profile` selects which trust domain's `settings.json` is written. The two
 * profiles keep physically separate `user-data-dir`s, so painting the wrong one
 * leaves the visible workbench in stock VS Code colours while quietly editing
 * an editor the user is not looking at.
 */
export function useCodeServerSettingsSync(
  enabled: boolean,
  profile: CodeServerProfile = "managed"
): void {
  const { resolvedTheme } = useTheme()
  const colorTheme = useSettingsStore((s) => s.colorTheme)
  const activeCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const activePluginThemeId = useSettingsStore((s) => s.activePluginThemeId)
  const customThemes = useSettingsStore((s) => s.customThemes)
  const accentColor = useSettingsStore((s) => s.accentColor)
  const a11y = useSettingsStore((s) => s.settings?.a11y)
  const motion = useSettingsStore((s) => s.settings?.motion)
  const monacoLink = useSettingsStore((s) => s.monacoLink)
  const editor = useCanvasSettingsStore((s) => s.settings.editor)
  const accessibility = useCanvasSettingsStore((s) => s.settings.accessibility)
  const pluginThemes = useSyncExternalStore(
    subscribeThemeRegistry,
    listPluginThemes,
    getServerPluginThemes
  )

  useEffect(() => {
    if (!enabled || !isTauri() || !resolvedTheme) return
    let cancelled = false
    void (async () => {
      const activePluginTheme = activePluginThemeId
        ? (pluginThemes.find((t) => t.id === activePluginThemeId) ?? null)
        : null
      const palette = resolveAppPalette({
        colorTheme,
        resolvedTheme,
        activeCustomThemeId,
        customThemes,
        accentColor,
        a11y,
        pluginTheme: activePluginTheme,
      })
      // Mirrors `use-canvas-monaco-setup`'s resolution order: high contrast is an
      // accessibility need and outranks a pinned theme, which in turn means the
      // user took the editor's colours into their own hands.
      const linkTheme = palette.highContrast || (monacoLink.enabled && !monacoLink.lockedThemeId)
      // The native webview paints its own background underneath code-server, so
      // it has to follow the palette too or a reload shows a flash of the
      // platform default. Routed through `getShellColors` — the same helper the
      // desktop window and the mobile status bar use — so there is one
      // palette-token-to-shell-hex conversion rather than a second one here.
      if (linkTheme) {
        setCodeServerPaneBackground(
          getShellColors(
            {
              colorTheme,
              activeCustomThemeId,
              customThemes,
              accentColor,
              a11y,
              pluginTheme: activePluginTheme,
            },
            palette.variant
          ).backgroundHex
        )
      }
      const managed = buildCodeServerSettings({
        colors: palette.colors,
        variant: palette.variant,
        highContrast: palette.highContrast,
        editor,
        accessibility,
        motion,
        linkTheme,
      })
      // Read-merge-write so anything the user set from inside VS Code survives.
      const existing = await codeServerClient.readUserSettings(profile).catch(() => "")
      if (cancelled) return
      await codeServerClient
        .writeUserSettings(
          mergeCodeServerSettings(existing, managed, {
            preserve: linkTheme ? undefined : CODESERVER_THEME_SETTING_KEYS,
          }),
          profile
        )
        // A theming failure must never take the editor down with it.
        .catch(() => undefined)
    })()
    return () => {
      cancelled = true
    }
  }, [
    enabled,
    profile,
    resolvedTheme,
    colorTheme,
    activeCustomThemeId,
    activePluginThemeId,
    customThemes,
    accentColor,
    a11y,
    motion,
    monacoLink,
    editor,
    accessibility,
    pluginThemes,
  ])
}
