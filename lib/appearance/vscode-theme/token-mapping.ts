// Maps VSCode color theme keys onto the cognia `ThemeColors` shape.
//
// The per-token key lists moved into `lib/appearance/theme-token-catalog.ts`
// (one table for a token's CSS variable, group, defaults *and* its VSCode
// sources) — this module now just projects the catalog into the two shapes the
// parser and the editor have always imported, so no call site had to change.
//
// We use the VSCode "Theme Color" reference as the source of truth — see
// https://code.visualstudio.com/api/references/theme-color. Each cognia color
// slot has an ordered list of VSCode keys we'll try; the first one present
// wins. A theme missing all of them gets a derived color from the bg/fg pair
// (handled in `parse-json.ts`).
//
// Behavior tests live in `parse-json.test.ts` so they exercise the full
// pipeline at once.

import type { ThemeColors } from "@/types/plugin/plugin"
import { THEME_COLOR_KEYS, THEME_TOKEN_CATALOG } from "../theme-token-catalog"

export { THEME_COLOR_KEYS }

/**
 * For each cognia ThemeColors key, the ordered list of VSCode color keys to
 * consult. The first non-empty match wins.
 *
 * Partial by construction: the workflow, effort, and brand tokens have no
 * honest VSCode counterpart, and guessing one from `tokenColors` is an explicit
 * ADR-0007 non-goal. A token with no entry here simply keeps the cognia default
 * for the imported theme's variant.
 */
export const VSCODE_COLOR_MAP: Partial<Record<keyof ThemeColors, readonly string[]>> =
  Object.fromEntries(
    THEME_TOKEN_CATALOG.filter((def) => def.vscode !== undefined).map((def) => [
      def.key,
      def.vscode as readonly string[],
    ])
  )

/**
 * Default fallback palette used when a VSCode theme literally doesn't
 * provide any of the keys we look for. We keep two — one each for light
 * and dark — and let the parser pick based on the theme's `type` field.
 *
 * These match the existing cognia "default" preset so the UI feels
 * consistent regardless of which theme was imported.
 */
export const DEFAULT_FALLBACKS: { light: ThemeColors; dark: ThemeColors } = {
  light: {
    primary: "#3b82f6",
    primaryForeground: "#ffffff",
    secondary: "#64748b",
    secondaryForeground: "#ffffff",
    accent: "#3b82f6",
    accentForeground: "#ffffff",
    background: "#ffffff",
    foreground: "#0f172a",
    muted: "#f1f5f9",
    mutedForeground: "#64748b",
    card: "#ffffff",
    cardForeground: "#0f172a",
    popover: "#ffffff",
    popoverForeground: "#0f172a",
    input: "#e2e8f0",
    border: "#e2e8f0",
    ring: "#3b82f6",
    destructive: "#ef4444",
    destructiveForeground: "#ffffff",
    sidebar: "#f8fafc",
    sidebarForeground: "#0f172a",
    sidebarPrimary: "#3b82f6",
    sidebarBorder: "#e2e8f0",
    sidebarPrimaryForeground: "#ffffff",
    sidebarAccent: "#f1f5f9",
    sidebarAccentForeground: "#0f172a",
    sidebarRing: "#3b82f6",
  },
  dark: {
    primary: "#60a5fa",
    primaryForeground: "#0b1220",
    secondary: "#94a3b8",
    secondaryForeground: "#0b1220",
    accent: "#60a5fa",
    accentForeground: "#0b1220",
    background: "#0b1220",
    foreground: "#f1f5f9",
    muted: "#1e293b",
    mutedForeground: "#94a3b8",
    card: "#0f172a",
    cardForeground: "#f1f5f9",
    popover: "#0f172a",
    popoverForeground: "#f1f5f9",
    input: "#1e293b",
    border: "#1e293b",
    ring: "#60a5fa",
    destructive: "#f87171",
    destructiveForeground: "#0b1220",
    sidebar: "#0f172a",
    sidebarForeground: "#f1f5f9",
    sidebarPrimary: "#60a5fa",
    sidebarBorder: "#1e293b",
    sidebarPrimaryForeground: "#0b1220",
    sidebarAccent: "#1e293b",
    sidebarAccentForeground: "#f1f5f9",
    sidebarRing: "#60a5fa",
  },
}
