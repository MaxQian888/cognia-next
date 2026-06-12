/**
 * Built-in TUI themes. Each is a {@link BaseColors} set expanded into a full
 * {@link ThemePalette}. `classic` reproduces the historic hardcoded ANSI look
 * byte-for-byte (it is the default, so adopting the theme system changes nothing
 * until the user opts into another theme). The hex themes mirror the spirit of
 * Claude Code's built-in set (dark / light + colour-blind "daltonized" variants)
 * and rely on Ink/chalk down-sampling truecolour to the terminal.
 */
import { expandPalette, type BaseColors, type ThemePalette } from "./palette"

/**
 * The classic ANSI palette — every role maps to the exact colour name the
 * components used before the theme system existed, so `classic` is a no-op
 * visual change. Keep these in sync with the historic hardcoded values.
 */
export const CLASSIC: BaseColors = {
  accent: "cyan",
  secondary: "magenta",
  info: "blue",
  success: "green",
  warning: "yellow",
  danger: "red",
  muted: "gray",
}

// Tokyo-Night-storm-ish dark truecolour palette.
const DARK: BaseColors = {
  accent: "#7dcfff",
  secondary: "#bb9af7",
  info: "#7aa2f7",
  success: "#9ece6a",
  warning: "#e0af68",
  danger: "#f7768e",
  muted: "#565f89",
  text: "#c0caf5",
}

// GitHub-light-ish palette.
const LIGHT: BaseColors = {
  accent: "#0969da",
  secondary: "#8250df",
  info: "#0550ae",
  success: "#1a7f37",
  warning: "#9a6700",
  danger: "#cf222e",
  muted: "#6e7781",
  text: "#1f2328",
}

// Wong colour-blind-safe palette on a dark background (deuteranopia-friendly:
// blue/orange/vermillion instead of red/green confusion pairs).
export const DARK_DALTONIZED: BaseColors = {
  accent: "#56b4e9",
  secondary: "#cc79a7",
  info: "#0072b2",
  success: "#009e73",
  warning: "#e69f00",
  danger: "#d55e00",
  muted: "#999999",
  text: "#f0f0f0",
}

// Wong palette tuned for a light background.
export const LIGHT_DALTONIZED: BaseColors = {
  accent: "#0072b2",
  secondary: "#cc79a7",
  info: "#56b4e9",
  success: "#009e73",
  warning: "#e69f00",
  danger: "#d55e00",
  muted: "#666666",
  text: "#111111",
}

// Monochrome — accessibility / no-colour terminals. White emphasis, gray rest.
const MONO: BaseColors = {
  accent: "whiteBright",
  secondary: "white",
  info: "white",
  success: "white",
  warning: "white",
  danger: "white",
  muted: "gray",
}

/** The built-in theme registry, keyed by name. */
export const BUILTIN_THEMES: Record<string, ThemePalette> = {
  classic: expandPalette(CLASSIC),
  dark: expandPalette(DARK),
  light: expandPalette(LIGHT),
  "dark-daltonized": expandPalette(DARK_DALTONIZED),
  "light-daltonized": expandPalette(LIGHT_DALTONIZED),
  mono: expandPalette(MONO),
}

/** Built-in theme names, for pickers / validation / help. */
export const BUILTIN_THEME_NAMES = Object.keys(BUILTIN_THEMES) as readonly string[]

/** The default theme — preserves the historic look. */
export const DEFAULT_THEME_NAME = "classic"

/** Resolve a built-in palette by name, falling back to `classic`. */
export function getBuiltinTheme(name: string | undefined): ThemePalette {
  return (name && BUILTIN_THEMES[name]) || BUILTIN_THEMES.classic
}
