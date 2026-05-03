// Maps VSCode color theme keys onto the cognia `ThemeColors` shape.
//
// We use the VSCode "Theme Color" reference as the source of truth — see
// https://code.visualstudio.com/api/references/theme-color. Each cognia
// color slot has an ordered list of VSCode keys we'll try; the first one
// present wins. A theme that's missing all of them gets a derived color
// from the bg/fg pair (handled in `parse-json.ts`).
//
// This is data, not logic — keep the file focused. Behavior tests live in
// `parse-json.test.ts` so they exercise the full pipeline at once.

import type { ThemeColors } from "@/types/plugin/plugin-extended"

/**
 * For each cognia ThemeColors key, the ordered list of VSCode color keys
 * to consult. The first non-empty match wins. Keys cover most popular
 * VSCode themes (One Dark, Dracula, Solarized, GitHub, Monokai, Tokyo
 * Night, Material) — themes that omit all of them are extremely rare.
 */
export const VSCODE_COLOR_MAP: Record<keyof ThemeColors, readonly string[]> = {
  background: ["editor.background", "tab.activeBackground"],
  foreground: ["editor.foreground", "foreground"],

  primary: [
    "button.background",
    "button.hoverBackground",
    "activityBarBadge.background",
    "statusBarItem.prominentBackground",
  ],
  primaryForeground: ["button.foreground", "activityBarBadge.foreground"],

  secondary: [
    "panel.background",
    "sideBarSectionHeader.background",
    "editorGroupHeader.tabsBackground",
  ],
  secondaryForeground: ["panel.border", "tab.inactiveForeground", "foreground"],

  accent: [
    "tab.activeBackground",
    "list.activeSelectionBackground",
    "list.focusBackground",
    "editorLink.activeForeground",
  ],
  accentForeground: [
    "tab.activeForeground",
    "list.activeSelectionForeground",
    "list.focusForeground",
  ],

  muted: ["editor.lineHighlightBackground", "input.background", "editorWidget.background"],
  mutedForeground: [
    "descriptionForeground",
    "editorLineNumber.foreground",
    "tab.inactiveForeground",
  ],

  card: ["editorWidget.background", "panel.background", "sideBar.background", "editor.background"],
  cardForeground: ["editorWidget.foreground", "sideBar.foreground", "foreground"],

  border: [
    "panel.border",
    "editorWidget.border",
    "editorGroup.border",
    "tab.border",
    "input.border",
  ],
  ring: ["focusBorder", "editorWidget.border"],

  destructive: ["errorForeground", "editorError.foreground", "inputValidation.errorBorder"],
  destructiveForeground: ["editor.background"],
}

/** All ThemeColors keys, ordered exactly as we want them in the UI editor. */
export const THEME_COLOR_KEYS: readonly (keyof ThemeColors)[] = [
  "background",
  "foreground",
  "primary",
  "primaryForeground",
  "secondary",
  "secondaryForeground",
  "accent",
  "accentForeground",
  "muted",
  "mutedForeground",
  "card",
  "cardForeground",
  "border",
  "ring",
  "destructive",
  "destructiveForeground",
] as const

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
    border: "#e2e8f0",
    ring: "#3b82f6",
    destructive: "#ef4444",
    destructiveForeground: "#ffffff",
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
    border: "#1e293b",
    ring: "#60a5fa",
    destructive: "#f87171",
    destructiveForeground: "#0b1220",
  },
}
