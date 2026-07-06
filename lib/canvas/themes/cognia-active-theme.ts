/**
 * Derives a Monaco `EditorTheme` from the active appearance palette so the
 * canvas / skills editors paint with the user's chosen colors instead of the
 * stock VS Code defaults. Lives next to `theme-registry.ts` and rides through
 * its existing `toMonacoTheme` mapping — no parallel registry, no duplicate
 * color machinery.
 *
 * Appearance `ThemeColors` (27 semantic fields, e.g. `primary` / `accent` /
 * `mutedForeground`) → editor `EditorTheme.colors` (20 surface fields, e.g.
 * `cursor` / `selectionHighlight` / `lineHighlight`). The mapping derives
 * editor-only surfaces by lightening / darkening the appearance neutrals and
 * adds the alpha suffixes Monaco expects on selection / scrollbar tokens.
 *
 * Inputs may be hex (preset palettes) or oklch (custom themes). We convert to
 * hex via culori because Monaco's color parser doesn't honour oklch reliably.
 */
import { parse as parseCulori, formatHex } from "culori"
import { darken, lighten, parseHex, toHex } from "@/lib/appearance/vscode-theme/color-utils"
import type { ThemeColors as AppearanceColors } from "@/types/plugin/plugin"
import {
  themeRegistry,
  type EditorTheme,
  type MonacoThemeDefinition,
  type ThemeColors as EditorColors,
} from "./theme-registry"

export const COGNIA_ACTIVE_THEME_ID = "cognia-active"
const COGNIA_ACTIVE_THEME_NAME = "Cognia Active"

const HEX_6 = /^#[0-9a-fA-F]{6}$/

/**
 * Best-effort conversion of any CSS color string to a 6-digit hex.
 * Used because Monaco's color parser doesn't honour oklch reliably.
 */
function toHexSafe(value: string | undefined, fallback: string): string {
  if (!value) return fallback
  const rgb = parseHex(value)
  if (rgb) return toHex(rgb)
  try {
    const parsed = parseCulori(value)
    if (parsed) {
      const hex = formatHex(parsed)
      if (hex && HEX_6.test(hex)) return hex
    }
  } catch {
    // fall through to fallback
  }
  return fallback
}

/** Append a two-char alpha suffix to a 6-digit hex; passthrough otherwise. */
function withAlpha(hex: string, alphaHex: string): string {
  if (!HEX_6.test(hex)) return hex
  return `${hex}${alphaHex}`
}

/**
 * Build the editor theme that matches the user's current appearance palette.
 * Pure: no DOM or Monaco side effects.
 */
export function buildCogniaActiveEditorTheme(
  appearance: AppearanceColors,
  variant: "light" | "dark"
): EditorTheme {
  const isDark = variant === "dark"

  const bg = toHexSafe(appearance.background, isDark ? "#0b1220" : "#ffffff")
  const fg = toHexSafe(appearance.foreground, isDark ? "#f1f5f9" : "#0f172a")
  const primary = toHexSafe(appearance.primary, isDark ? "#60a5fa" : "#3b82f6")
  const accent = toHexSafe(appearance.accent, primary)
  const mutedFg = toHexSafe(appearance.mutedForeground, isDark ? "#94a3b8" : "#64748b")
  const border = toHexSafe(appearance.border, isDark ? "#1e293b" : "#e2e8f0")

  // Editor-specific surfaces derived from the appearance neutrals so they
  // contrast against the chosen background without needing extra tokens.
  const lineHighlight = isDark ? lighten(bg, 0.06) : darken(bg, 0.04)
  const indentGuide = isDark ? lighten(bg, 0.12) : darken(bg, 0.08)
  const activeIndentGuide = isDark ? lighten(border, 0.16) : darken(border, 0.16)

  const colors: EditorColors = {
    background: bg,
    foreground: fg,
    cursor: fg,
    selection: withAlpha(primary, "55"),
    selectionHighlight: withAlpha(primary, "26"),
    lineHighlight,
    lineNumber: mutedFg,
    lineNumberActive: fg,
    gutterBackground: bg,
    gutterForeground: mutedFg,
    scrollbarSlider: withAlpha(mutedFg, "55"),
    scrollbarSliderHover: withAlpha(mutedFg, "99"),
    scrollbarSliderActive: withAlpha(fg, "66"),
    editorIndentGuide: indentGuide,
    editorActiveIndentGuide: activeIndentGuide,
    matchingBracket: withAlpha(primary, "33"),
    findMatch: withAlpha(accent, "55"),
    findMatchHighlight: withAlpha(accent, "33"),
    // The minimap is a <canvas> whose clear color is `minimap.background`; CSS
    // cannot make its pixels transparent. Clearing it to a fully-transparent
    // form of the editor background lets a canvas wallpaper show through the
    // minimap the same way the CSS override does for the main editor. Without a
    // wallpaper this is visually identical — the editor background painted
    // behind the minimap is the same `bg`.
    minimap: withAlpha(bg, "00"),
    minimapSlider: withAlpha(mutedFg, "55"),
  }

  return {
    id: COGNIA_ACTIVE_THEME_ID,
    name: COGNIA_ACTIVE_THEME_NAME,
    dark: isDark,
    base: isDark ? "vs-dark" : "vs",
    colors,
    // Empty token rules + base inheritance (set by `toMonacoTheme`'s
    // `inherit: true`) preserves the base theme's syntax highlighting.
    tokenColors: [],
  }
}

interface MonacoNamespace {
  editor: {
    defineTheme(name: string, data: MonacoThemeDefinition): void
  }
}

/**
 * Build, register on the shared `themeRegistry`, and install on Monaco under
 * the stable id `"cognia-active"`. Idempotent — both `registerTheme` and
 * `defineTheme` are Map.set semantics, so re-syncing on every token change
 * just overwrites in place.
 */
export function syncCogniaActiveTheme(
  monaco: MonacoNamespace,
  appearance: AppearanceColors,
  variant: "light" | "dark"
): void {
  const theme = buildCogniaActiveEditorTheme(appearance, variant)
  themeRegistry.registerTheme(theme)
  monaco.editor.defineTheme(COGNIA_ACTIVE_THEME_ID, themeRegistry.toMonacoTheme(theme))
}
