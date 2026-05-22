/**
 * Shell-color helper — derives the background / foreground hex pair that the
 * three native shells (Tauri desktop window, Capacitor iOS status bar,
 * Capacitor Android navigation bar) should paint to match the active
 * appearance palette.
 *
 * Pure: callers (TauriProvider, CompanionBootProvider) pass in the appearance
 * slice and the next-themes resolved theme; this module just converts to hex.
 * Centralising the conversion here means the Rust window command, the iOS
 * status-bar wrapper, and the Android nav-bar wrapper all stay in lockstep
 * without each re-implementing oklch → hex.
 */

import { formatHex, parse as parseCulori } from "culori"
import { parseHex, toHex } from "@/lib/appearance/vscode-theme/color-utils"
import { resolveActiveThemeColors } from "@/lib/themes"
import type { ColorThemePreset, CustomTheme } from "@/types/plugin/plugin-extended"

/** Minimal appearance slice the helper needs. Avoids importing the full
 *  AppSettings shape so the helper stays decoupled from store internals. */
export interface ShellSyncAppearanceState {
  colorTheme: ColorThemePreset
  activeCustomThemeId: string | null
  customThemes: CustomTheme[]
}

export interface ShellColors {
  backgroundHex: string
  foregroundHex: string
  isDark: boolean
}

const FALLBACK_LIGHT: ShellColors = {
  backgroundHex: "#ffffff",
  foregroundHex: "#0f172a",
  isDark: false,
}

const FALLBACK_DARK: ShellColors = {
  backgroundHex: "#0b1220",
  foregroundHex: "#f1f5f9",
  isDark: true,
}

/**
 * Convert any CSS color string to a 6-digit hex. Hex inputs pass through; oklch
 * / rgb / hsl values go through culori. Returns `null` for unparseable input
 * so callers can fall back to a known-good default rather than emitting an
 * empty string.
 */
function toHexOrNull(value: string | undefined): string | null {
  if (!value) return null
  const rgb = parseHex(value)
  if (rgb) return toHex(rgb)
  try {
    const parsed = parseCulori(value)
    if (parsed) {
      const hex = formatHex(parsed)
      if (hex) return hex
    }
  } catch {
    /* fall through */
  }
  return null
}

/**
 * Resolve the shell-paint colors for the active appearance state. Pure — no
 * DOM, no Zustand subscription, no Tauri / Capacitor IPC. Callers own the
 * subscription and pass `state` + `resolvedTheme` in.
 */
export function getShellColors(
  state: ShellSyncAppearanceState,
  resolvedTheme: "light" | "dark" | string | undefined
): ShellColors {
  const variant: "light" | "dark" = resolvedTheme === "dark" ? "dark" : "light"
  const fallback = variant === "dark" ? FALLBACK_DARK : FALLBACK_LIGHT

  const resolved = resolveActiveThemeColors({
    colorTheme: state.colorTheme,
    resolvedTheme: variant,
    activeCustomThemeId: state.activeCustomThemeId,
    customThemes: state.customThemes,
  })

  const backgroundHex = toHexOrNull(resolved.colors.background) ?? fallback.backgroundHex
  const foregroundHex = toHexOrNull(resolved.colors.foreground) ?? fallback.foregroundHex

  return {
    backgroundHex,
    foregroundHex,
    isDark: variant === "dark",
  }
}
