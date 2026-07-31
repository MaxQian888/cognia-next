// Single source of truth for the 8 color PRESETS.
//
// The preset palettes used to be duplicated in three unsynced places:
//   - `lib/themes/index.ts` (PRESETS — the resolved light/dark hex overrides)
//   - `components/settings/appearance/tabs/theme-tab.tsx` (PRESET_SWATCHES)
//   - the `ColorThemePreset` union in `types/plugin/plugin.ts` (the id list)
// Adding a preset meant editing all three. This module is now the one place
// that owns the accent triple (primary / accent / ring) per light/dark
// variant; `lib/themes/index.ts` derives PRESETS + COLOR_PRESETS from it, and
// the theme tab derives its swatches from it. Only the `ColorThemePreset`
// TYPE stays in `types/plugin/plugin.ts` (a type can't live in a value module
// without a cycle); a test asserts the two stay in lockstep.

import type { ColorThemePreset } from "@/types/plugin/plugin"

/** The accent tokens a preset overrides over the shared neutral surface. */
export interface PresetAccent {
  primary: string
  accent: string
  ring: string
}

export interface PresetMeta {
  id: ColorThemePreset
  light: PresetAccent
  dark: PresetAccent
}

export const PRESET_META: readonly PresetMeta[] = [
  {
    id: "default",
    light: { primary: "#3b82f6", accent: "#3b82f6", ring: "#3b82f6" },
    dark: { primary: "#60a5fa", accent: "#60a5fa", ring: "#60a5fa" },
  },
  {
    id: "ocean",
    light: { primary: "#0284c7", accent: "#0ea5e9", ring: "#0284c7" },
    dark: { primary: "#38bdf8", accent: "#7dd3fc", ring: "#38bdf8" },
  },
  {
    id: "forest",
    light: { primary: "#16a34a", accent: "#22c55e", ring: "#16a34a" },
    dark: { primary: "#4ade80", accent: "#86efac", ring: "#4ade80" },
  },
  {
    id: "sunset",
    light: { primary: "#ea580c", accent: "#f97316", ring: "#ea580c" },
    dark: { primary: "#fb923c", accent: "#fdba74", ring: "#fb923c" },
  },
  {
    id: "lavender",
    light: { primary: "#7c3aed", accent: "#8b5cf6", ring: "#7c3aed" },
    dark: { primary: "#a78bfa", accent: "#c4b5fd", ring: "#a78bfa" },
  },
  {
    id: "rose",
    light: { primary: "#e11d48", accent: "#f43f5e", ring: "#e11d48" },
    dark: { primary: "#fb7185", accent: "#fda4af", ring: "#fb7185" },
  },
  {
    id: "slate",
    light: { primary: "#475569", accent: "#64748b", ring: "#475569" },
    dark: { primary: "#94a3b8", accent: "#cbd5e1", ring: "#94a3b8" },
  },
  {
    id: "amber",
    light: { primary: "#d97706", accent: "#f59e0b", ring: "#d97706" },
    dark: { primary: "#fbbf24", accent: "#fcd34d", ring: "#fbbf24" },
  },
]

/** Ordered preset ids — the single source for `COLOR_PRESETS`. */
export const PRESET_IDS: readonly ColorThemePreset[] = PRESET_META.map((m) => m.id)

/** Swatch dot colors (the preset's primary hue) per variant, for the picker. */
export const PRESET_SWATCHES: Record<ColorThemePreset, { light: string; dark: string }> =
  Object.fromEntries(
    PRESET_META.map((m) => [m.id, { light: m.light.primary, dark: m.dark.primary }])
  ) as Record<ColorThemePreset, { light: string; dark: string }>
