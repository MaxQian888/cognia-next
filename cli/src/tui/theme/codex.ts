/**
 * Reuse the user's Codex CLI theme — but ONLY its code-block syntax-highlight
 * choice, because Codex's `tui.theme` (a syntect/`.tmTheme` name) controls only
 * highlighting and diffs, not semantic UI chrome (openai/codex#21130). So the
 * reuse path keeps our own UI palette (classic) and overrides just the
 * `code*` tokens, mapped from the Codex theme name to a curated palette.
 *
 * Opt-in: consulted only when the CLI's `theme` is `"codex"` (see
 * {@link ./resolve}). No TOML dependency — a tiny targeted parser reads
 * `tui.theme` from `~/.codex/config.toml`.
 */
import path from "node:path"

import type { ThemeFileReader } from "./claude-code"
import { expandPalette, type BaseColors, type ThemePalette } from "./palette"

export interface CodexThemeOptions {
  /** OS home (`~`). The Codex config lives at `<osHome>/.codex/config.toml`. */
  osHome: string
  read: ThemeFileReader
}

/**
 * Extract the `tui.theme` value from a Codex `config.toml`, supporting both the
 * dotted form (`tui.theme = "x"`) and a `theme` key inside a `[tui]` section.
 * Returns null when absent. Deliberately minimal — not a full TOML parser.
 */
export function parseCodexThemeName(toml: string): string | null {
  // Dotted assignment anywhere: tui.theme = "x"
  const dotted = /^\s*tui\.theme\s*=\s*['"]([^'"]+)['"]/m.exec(toml)
  if (dotted) return dotted[1]

  // theme = "x" within the [tui] section (until the next [section] header).
  const lines = toml.split(/\r?\n/)
  let inTui = false
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (section) {
      inTui = section[1].trim() === "tui"
      continue
    }
    if (!inTui) continue
    const kv = /^\s*theme\s*=\s*['"]([^'"]+)['"]/.exec(line)
    if (kv) return kv[1]
  }
  return null
}

/** Read the Codex highlight theme name, or null when Codex isn't configured. */
export function readCodexHighlightTheme(opts: CodexThemeOptions): string | null {
  const raw = opts.read(path.join(opts.osHome, ".codex", "config.toml"))
  if (raw === null) return null
  return parseCodexThemeName(raw)
}

// Curated mapping of well-known Codex/bat theme names to a base palette we use
// to derive the code-block tokens. We can't reproduce all 32 .tmThemes, so an
// unknown name falls back to a neutral dark base — the user still gets a themed,
// consistent code block, and the name is surfaced for transparency.
const CODEX_BASES: Record<string, BaseColors> = {
  dracula: {
    accent: "#bd93f9",
    secondary: "#ff79c6",
    info: "#8be9fd",
    success: "#50fa7b",
    warning: "#f1fa8c",
    danger: "#ff5555",
    muted: "#6272a4",
  },
  "gruvbox-dark": {
    accent: "#fabd2f",
    secondary: "#d3869b",
    info: "#83a598",
    success: "#b8bb26",
    warning: "#fe8019",
    danger: "#fb4934",
    muted: "#928374",
  },
  "catppuccin-mocha": {
    accent: "#cba6f7",
    secondary: "#f5c2e7",
    info: "#89dceb",
    success: "#a6e3a1",
    warning: "#f9e2af",
    danger: "#f38ba8",
    muted: "#6c7086",
  },
  "tokyonight-storm": {
    accent: "#7dcfff",
    secondary: "#bb9af7",
    info: "#7aa2f7",
    success: "#9ece6a",
    warning: "#e0af68",
    danger: "#f7768e",
    muted: "#565f89",
  },
  "solarized-light": {
    accent: "#268bd2",
    secondary: "#d33682",
    info: "#2aa198",
    success: "#859900",
    warning: "#b58900",
    danger: "#dc322f",
    muted: "#93a1a1",
  },
}

const CODEX_FALLBACK: BaseColors = {
  accent: "#7dcfff",
  secondary: "#bb9af7",
  info: "#7aa2f7",
  success: "#9ece6a",
  warning: "#e0af68",
  danger: "#f7768e",
  muted: "#808080",
}

/** The code-block token keys a Codex reuse overrides — UI tokens stay untouched. */
const CODE_TOKENS = [
  "codeKeyword",
  "codeString",
  "codeNumber",
  "codeComment",
  "codeFunction",
  "codeBuiltin",
] as const

/**
 * Build the code-block-only token overrides for a Codex theme name. Returns just
 * the `code*` tokens (plus `codeHighlight` = the name) so the caller can layer
 * them onto an otherwise-classic UI palette.
 */
export function codexCodeOverrides(name: string): Partial<ThemePalette> {
  const base = CODEX_BASES[name] ?? CODEX_FALLBACK
  const full = expandPalette(base)
  const out: Partial<ThemePalette> = { codeHighlight: name }
  for (const key of CODE_TOKENS) out[key] = full[key]
  return out
}
