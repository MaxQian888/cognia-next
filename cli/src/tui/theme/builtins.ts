/**
 * Built-in TUI themes. Each is a {@link BaseColors} set expanded into a full
 * {@link ThemePalette}. `cognia` is the signature default — a warm, Claude-Code-
 * inspired dark palette (brand accent `#d77757`) that gives the CLI a polished
 * out-of-box look. `ansi` reproduces the historic hardcoded 16-colour look
 * byte-for-byte for users who'd rather inherit their terminal's own palette
 * (and is the back-compat target of the legacy `classic` name). The hex themes
 * mirror Claude Code's built-in set (dark / light + colour-blind "daltonized"
 * variants) and rely on Ink/chalk down-sampling truecolour to the terminal.
 */
import { expandPalette, type BaseColors, type ThemePalette } from "./palette"

/**
 * The raw ANSI palette (registered as `ansi`; legacy name `classic`) — every
 * role maps to the exact colour name the components used before the theme system
 * existed, so it inherits the terminal's own 16-colour scheme. Keep these in sync
 * with the historic hardcoded values.
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

/**
 * The signature Cognia palette — a warm dark theme modelled on Claude Code's
 * default look. The brand accent is Claude's `#d77757`; success/error follow the
 * documented Claude dark values so the default reads consistently with the
 * `claude-code` reuse path (which shares this base — see `./claude-code`).
 */
export const COGNIA_DARK: BaseColors = {
  accent: "#d77757", // brand "claude" warm orange
  secondary: "#b18cf2",
  info: "#6cb6ff",
  success: "#4eba65", // documented Claude dark success
  warning: "#e0af68",
  danger: "#ff6b80", // documented Claude dark error
  muted: "#8b8b8b",
  text: "#e6e6e6",
}

/** Light-background companion to {@link COGNIA_DARK}; shared with the
 * `claude-code` reuse path so a reused Claude light theme matches. */
export const COGNIA_LIGHT: BaseColors = {
  accent: "#d77757",
  secondary: "#8250df",
  info: "#0550ae",
  success: "#2c7a39", // documented Claude light success
  warning: "#9a6700",
  danger: "#ab2b3f", // documented Claude light error
  muted: "#6e7781",
  text: "#1f2328",
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

/**
 * The built-in theme registry, keyed by name. Insertion order drives the
 * `/theme` picker order, so the signature `cognia` default leads.
 */
export const BUILTIN_THEMES: Record<string, ThemePalette> = {
  cognia: expandPalette(COGNIA_DARK),
  dark: expandPalette(DARK),
  light: expandPalette(LIGHT),
  "dark-daltonized": expandPalette(DARK_DALTONIZED),
  "light-daltonized": expandPalette(LIGHT_DALTONIZED),
  ansi: expandPalette(CLASSIC),
  mono: expandPalette(MONO),
}

/** Built-in theme names, for pickers / validation / help. */
export const BUILTIN_THEME_NAMES = Object.keys(BUILTIN_THEMES) as readonly string[]

/** The default theme — the signature warm Cognia dark palette. */
export const DEFAULT_THEME_NAME = "cognia"

/**
 * Back-compat aliases for renamed theme keys, so a config written before a rename
 * keeps resolving. `classic` was the original raw-ANSI default, now `ansi`.
 */
const THEME_ALIASES: Readonly<Record<string, string>> = { classic: "ansi" }

/**
 * Resolve a built-in palette by name. An empty/unknown name falls back to the
 * {@link DEFAULT_THEME_NAME default} so the UI is never left uncoloured; a legacy
 * name ({@link THEME_ALIASES}) resolves to its current key.
 */
export function getBuiltinTheme(name: string | undefined): ThemePalette {
  if (!name) return BUILTIN_THEMES[DEFAULT_THEME_NAME]
  const key = THEME_ALIASES[name] ?? name
  return BUILTIN_THEMES[key] ?? BUILTIN_THEMES[DEFAULT_THEME_NAME]
}
