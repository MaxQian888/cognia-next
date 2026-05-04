/**
 * Theme resolution helpers used by the plugin Theme API.
 *
 * cognia-next stores active appearance fields (`theme`, `colorTheme`,
 * `activeCustomThemeId`) on `AppSettings`, and user-built custom themes
 * in the localStorage-backed `useCustomThemeStore`. Plugin code asks
 * "what colors are showing right now?" — this module merges those two
 * surfaces into a single `ResolvedTheme`.
 *
 * Persistence live in `stores/settings/settings-store.ts` and
 * `stores/theme/custom-theme-store.ts`. This module is pure: it
 * derives the resolved palette from a snapshot, so the plugin runtime
 * can call it from anywhere without taking a Zustand subscription.
 */

import type { ColorThemePreset, ThemeColors, CustomTheme } from "@/types/plugin/plugin-extended"

/** Available built-in color presets. Mirrors `ColorThemePreset`. */
export const COLOR_PRESETS: readonly ColorThemePreset[] = [
  "default",
  "ocean",
  "forest",
  "sunset",
  "lavender",
  "rose",
  "slate",
  "amber",
] as const

/** A single light/dark palette pair for one preset. */
interface PresetPair {
  light: ThemeColors
  dark: ThemeColors
}

// Visual tokens are deliberately conservative — they exist so the
// plugin Theme API can answer `getColors()` even when the user hasn't
// applied a custom theme. The full Tailwind / shadcn variables are
// owned by `app/globals.css`; do not duplicate them here.
const NEUTRAL_LIGHT: ThemeColors = {
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
}

const NEUTRAL_DARK: ThemeColors = {
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
}

const PRESETS: Record<ColorThemePreset, PresetPair> = {
  default: { light: NEUTRAL_LIGHT, dark: NEUTRAL_DARK },
  ocean: {
    light: { ...NEUTRAL_LIGHT, primary: "#0284c7", accent: "#0ea5e9", ring: "#0284c7" },
    dark: { ...NEUTRAL_DARK, primary: "#38bdf8", accent: "#7dd3fc", ring: "#38bdf8" },
  },
  forest: {
    light: { ...NEUTRAL_LIGHT, primary: "#16a34a", accent: "#22c55e", ring: "#16a34a" },
    dark: { ...NEUTRAL_DARK, primary: "#4ade80", accent: "#86efac", ring: "#4ade80" },
  },
  sunset: {
    light: { ...NEUTRAL_LIGHT, primary: "#ea580c", accent: "#f97316", ring: "#ea580c" },
    dark: { ...NEUTRAL_DARK, primary: "#fb923c", accent: "#fdba74", ring: "#fb923c" },
  },
  lavender: {
    light: { ...NEUTRAL_LIGHT, primary: "#7c3aed", accent: "#8b5cf6", ring: "#7c3aed" },
    dark: { ...NEUTRAL_DARK, primary: "#a78bfa", accent: "#c4b5fd", ring: "#a78bfa" },
  },
  rose: {
    light: { ...NEUTRAL_LIGHT, primary: "#e11d48", accent: "#f43f5e", ring: "#e11d48" },
    dark: { ...NEUTRAL_DARK, primary: "#fb7185", accent: "#fda4af", ring: "#fb7185" },
  },
  slate: {
    light: { ...NEUTRAL_LIGHT, primary: "#475569", accent: "#64748b", ring: "#475569" },
    dark: { ...NEUTRAL_DARK, primary: "#94a3b8", accent: "#cbd5e1", ring: "#94a3b8" },
  },
  amber: {
    light: { ...NEUTRAL_LIGHT, primary: "#d97706", accent: "#f59e0b", ring: "#d97706" },
    dark: { ...NEUTRAL_DARK, primary: "#fbbf24", accent: "#fcd34d", ring: "#fbbf24" },
  },
}

export interface ResolveActiveThemeArgs {
  colorTheme: ColorThemePreset
  resolvedTheme: "light" | "dark"
  activeCustomThemeId: string | null
  customThemes: CustomTheme[]
}

export interface ResolvedTheme {
  colors: ThemeColors
  themeSource: "preset" | "custom"
}

/**
 * Resolve the colors that should currently be showing.
 *
 * If a custom theme is active and present in `customThemes`, its
 * tokens win (with any unspecified field falling back to the preset
 * neutral palette for the right light/dark mode). Otherwise the
 * preset's pair is used directly.
 *
 * Phase 2 introduced a dual-variant `tokens.{light, dark}` shape on
 * `CustomTheme`. Newly saved rows always carry it; older rows still
 * use the legacy single `colors` + `isDark` pair. This function
 * prefers the new shape and only consults the legacy fields when
 * `tokens` is absent — so unmigrated rows keep working while Task 8
 * ships the Dexie v16 migration.
 */
export function resolveActiveThemeColors(args: ResolveActiveThemeArgs): ResolvedTheme {
  const { colorTheme, resolvedTheme, activeCustomThemeId, customThemes } = args
  const presetPair = PRESETS[colorTheme] ?? PRESETS.default
  const presetColors = presetPair[resolvedTheme]

  if (activeCustomThemeId) {
    const custom = customThemes.find((t) => t.id === activeCustomThemeId)
    if (custom) {
      // Prefer the new dual-variant shape; fall back to legacy single
      // `colors`. The legacy path returns undefined when the row's
      // `isDark` doesn't match the active resolved theme — in that
      // case we fall through to the preset baseline (no overrides).
      const customColors =
        custom.tokens?.[resolvedTheme] ??
        (custom.isDark === (resolvedTheme === "dark") ? custom.colors : undefined)

      // Baseline: prefer new `baseVariant`, fall back to legacy `isDark`.
      const variantHint =
        custom.baseVariant ??
        (custom.isDark === true ? "dark" : custom.isDark === false ? "light" : undefined)
      const baseline =
        variantHint === "dark"
          ? presetPair.dark
          : variantHint === "light"
            ? presetPair.light
            : presetColors

      return {
        colors: { ...baseline, ...(customColors ?? {}) },
        themeSource: "custom",
      }
    }
  }

  return { colors: presetColors, themeSource: "preset" }
}
