"use client"

/**
 * useMonacoActiveTheme — shared Monaco theming for the Source Control editors
 * (DiffViewer, BlameView). Registers the `cognia-active` Monaco theme from the
 * live appearance palette so editors paint with the user's chosen colors
 * instead of stock VS Code, configures the offline Monaco loader, and re-syncs
 * whenever the palette or light/dark mode changes while an editor is mounted.
 *
 * Extracted from `diff-viewer.tsx` so the plain (non-diff) blame editor reuses
 * the exact same theming path — a single source of truth for the editor look.
 */

import { useCallback, useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { configureMonacoLoader } from "@/lib/canvas/monaco-loader"
import {
  COGNIA_ACTIVE_THEME_ID,
  syncCogniaActiveTheme,
} from "@/lib/canvas/themes/cognia-active-theme"
import { resolveActiveThemeColors } from "@/lib/themes"
import { useSettingsStore } from "@/stores"

type MonacoModule = typeof import("monaco-editor")

export interface UseMonacoActiveThemeResult {
  /** The theme id to pass as the editor `theme` prop. */
  themeId: string
  /** Define + activate the cognia-active theme on a Monaco namespace. */
  applyActiveTheme: (monaco: MonacoModule) => void
  /**
   * Call from the editor `onMount`: stores the live Monaco instance (so the
   * hook can re-sync on palette/mode change) and applies the theme immediately.
   */
  registerMonaco: (monaco: MonacoModule) => void
}

export function useMonacoActiveTheme(): UseMonacoActiveThemeResult {
  const { resolvedTheme } = useTheme()
  const monacoRef = useRef<MonacoModule | null>(null)

  const appearanceColorTheme = useSettingsStore((s) => s.colorTheme)
  const appearanceActiveCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const appearanceCustomThemes = useSettingsStore((s) => s.customThemes)

  // Offline Monaco asset loader (predev copies assets; never import manually).
  useEffect(() => {
    configureMonacoLoader()
  }, [])

  const applyActiveTheme = useCallback(
    (monaco: MonacoModule) => {
      if (!resolvedTheme) return
      const variant: "light" | "dark" = resolvedTheme === "dark" ? "dark" : "light"
      const resolved = resolveActiveThemeColors({
        colorTheme: appearanceColorTheme,
        resolvedTheme: variant,
        activeCustomThemeId: appearanceActiveCustomThemeId,
        customThemes: appearanceCustomThemes,
      })
      syncCogniaActiveTheme(
        monaco as unknown as Parameters<typeof syncCogniaActiveTheme>[0],
        resolved.colors,
        variant
      )
      // Re-apply explicitly so an already-mounted editor follows a light/dark
      // toggle (defineTheme only refreshes when cognia-active is the active
      // theme, which isn't guaranteed if the static `theme` prop was applied
      // before the theme existed).
      monaco.editor.setTheme(COGNIA_ACTIVE_THEME_ID)
    },
    [resolvedTheme, appearanceColorTheme, appearanceActiveCustomThemeId, appearanceCustomThemes]
  )

  const registerMonaco = useCallback(
    (monaco: MonacoModule) => {
      monacoRef.current = monaco
      applyActiveTheme(monaco)
    },
    [applyActiveTheme]
  )

  // Re-sync whenever the palette or light/dark mode changes while mounted.
  useEffect(() => {
    if (monacoRef.current) applyActiveTheme(monacoRef.current)
  }, [applyActiveTheme])

  return { themeId: COGNIA_ACTIVE_THEME_ID, applyActiveTheme, registerMonaco }
}
