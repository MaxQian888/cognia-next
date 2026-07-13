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

import type { ColorThemePreset, ThemeColors, CustomTheme } from "@/types/plugin/plugin"
import { PRESET_META, PRESET_IDS } from "./preset-meta"

/**
 * Available built-in color presets. Derived from the single-source
 * `PRESET_META` so the id list, palettes, and swatches never drift.
 */
export const COLOR_PRESETS: readonly ColorThemePreset[] = PRESET_IDS

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

// Build each preset pair by spreading the shared neutral surface and applying
// the preset's accent triple (primary / accent / ring) for each variant. The
// accent values are owned by the single-source `PRESET_META`.
const PRESETS: Record<ColorThemePreset, PresetPair> = Object.fromEntries(
  PRESET_META.map((meta) => [
    meta.id,
    {
      light: { ...NEUTRAL_LIGHT, ...meta.light },
      dark: { ...NEUTRAL_DARK, ...meta.dark },
    },
  ])
) as Record<ColorThemePreset, PresetPair>

export interface ResolveActiveThemeArgs {
  colorTheme: ColorThemePreset
  resolvedTheme: "light" | "dark"
  activeCustomThemeId: string | null
  customThemes: CustomTheme[]
  /**
   * Standalone accent override (a single hex/oklch color). When set, it
   * replaces `primary` / `accent` / `ring` on top of whatever preset or
   * custom theme resolved, so the user can retint the app without opening the
   * full custom-theme editor. The derived sidebar accents follow through
   * `deriveSidebarFromCore`. Undefined / null leaves the resolved palette
   * untouched.
   */
  accentColor?: string | null
}

export interface ResolvedTheme {
  colors: ThemeColors
  themeSource: "preset" | "custom"
}

/**
 * Each sidebar slot mirrors a core surface token. A theme that only edits the
 * core palette (`--background`, `--accent`, …) but leaves the sidebar slots
 * untouched used to keep the fixed neutral sidebar colours, so the sidebar
 * visually diverged from the rest of the themed app. We instead let an
 * untouched sidebar slot DERIVE from its core counterpart, so the sidebar
 * always belongs to the active theme's palette. A theme that *explicitly*
 * customises a sidebar slot (its value differs from the neutral fallback)
 * keeps that value — derivation only fills the slots the theme didn't set.
 */
const SIDEBAR_CORE_SOURCE: Readonly<Partial<Record<keyof ThemeColors, keyof ThemeColors>>> = {
  sidebar: "background",
  sidebarForeground: "foreground",
  sidebarPrimary: "primary",
  sidebarPrimaryForeground: "primaryForeground",
  sidebarAccent: "accent",
  sidebarAccentForeground: "accentForeground",
  sidebarBorder: "border",
  sidebarRing: "ring",
}

/**
 * For each sidebar slot still sitting at the variant's neutral fallback,
 * replace it with the resolved value of the core token it mirrors. Returns a
 * new object; never mutates `colors`. The neutral fallback used as the
 * "untouched" sentinel is the module's own `NEUTRAL_*` palette, whose sidebar
 * values are identical to `lib/appearance` `DEFAULT_FALLBACKS` — so themes
 * saved through the custom-theme editor (which fills unset slots from those
 * fallbacks) are correctly detected as "not customised" and derive.
 */
function deriveSidebarFromCore(colors: ThemeColors, variant: "light" | "dark"): ThemeColors {
  const neutral = variant === "dark" ? NEUTRAL_DARK : NEUTRAL_LIGHT
  const out: ThemeColors = { ...colors }
  for (const [sidebarKey, coreKey] of Object.entries(SIDEBAR_CORE_SOURCE) as Array<
    [keyof ThemeColors, keyof ThemeColors]
  >) {
    if (out[sidebarKey] !== neutral[sidebarKey]) continue // explicitly customised — keep it
    const coreValue = colors[coreKey]
    if (typeof coreValue === "string" && coreValue.length > 0) {
      out[sidebarKey] = coreValue
    }
  }
  return out
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
/**
 * Apply a standalone accent override onto a resolved palette. Retints
 * `primary` / `accent` / `ring`; the sidebar accents follow via
 * `deriveSidebarFromCore`. A blank / undefined color is a no-op.
 */
function applyAccentOverride(colors: ThemeColors, accentColor?: string | null): ThemeColors {
  if (typeof accentColor !== "string" || accentColor.length === 0) return colors
  return { ...colors, primary: accentColor, accent: accentColor, ring: accentColor }
}

export function resolveActiveThemeColors(args: ResolveActiveThemeArgs): ResolvedTheme {
  const { colorTheme, resolvedTheme, activeCustomThemeId, customThemes, accentColor } = args
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

      const merged = applyAccentOverride({ ...baseline, ...(customColors ?? {}) }, accentColor)
      return {
        colors: deriveSidebarFromCore(merged, resolvedTheme),
        themeSource: "custom",
      }
    }
  }

  return {
    colors: deriveSidebarFromCore(applyAccentOverride(presetColors, accentColor), resolvedTheme),
    themeSource: "preset",
  }
}
