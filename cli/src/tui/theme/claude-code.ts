/**
 * Reuse the user's existing Claude Code theme. Opt-in: only consulted when the
 * CLI's `theme` is set to `"claude-code"` (see {@link ../theme/resolve}). Reads
 * `~/.claude/settings.json` → `theme`, maps Claude's built-in themes to a
 * Claude-flavoured palette, and resolves a `custom:<slug>` theme from
 * `~/.claude/themes/<slug>.json` (its `base` + `overrides` token map).
 *
 * Grounded in the documented Claude theme model: built-in names
 * (`dark/light/dark-daltonized/light-daltonized/dark-ansi/light-ansi/auto`),
 * the brand colour `claude` = `#D77757`, and the five override colour formats
 * (handled by {@link normalizeColor}). Unknown tokens / unparseable values are
 * ignored, exactly as Claude does.
 */
import path from "node:path"

import { COGNIA_DARK, COGNIA_LIGHT, DARK_DALTONIZED, LIGHT_DALTONIZED, CLASSIC } from "./builtins"
import { normalizeColor } from "./color"
import { expandPalette, type BaseColors, type ThemePalette } from "./palette"

/** A reader returning a file's text, or null when it doesn't exist / can't be read. */
export type ThemeFileReader = (absPath: string) => string | null

export interface ClaudeThemeOptions {
  /** OS home (`~`). The Claude config lives under `<osHome>/.claude`. */
  osHome: string
  read: ThemeFileReader
}

/** Resolve a Claude built-in theme name (or a custom theme's `base`) to a base
 * palette. The Claude-flavoured dark/light bases are the shared {@link COGNIA_DARK}
 * / {@link COGNIA_LIGHT} (our default is itself Claude-modelled), so a reused
 * Claude theme matches the CLI's own default chrome. */
function baseFor(name: string | undefined): BaseColors {
  switch (name) {
    case "light":
      return { ...COGNIA_LIGHT }
    case "dark-daltonized":
      return { ...DARK_DALTONIZED }
    case "light-daltonized":
      return { ...LIGHT_DALTONIZED }
    case "dark-ansi":
    case "light-ansi":
      return { ...CLASSIC }
    case "dark":
    case "auto":
    default:
      return { ...COGNIA_DARK }
  }
}

// Claude override tokens that correspond to one of our base roles (applied to
// the BaseColors before expansion so derived tokens follow, e.g. border←accent).
const BASE_ROLE: Record<string, keyof BaseColors> = {
  claude: "accent",
  success: "success",
  error: "danger",
  warning: "warning",
  text: "text",
  subtle: "muted",
  inactive: "muted",
}

// Claude override tokens that map to a specific element token (applied after
// expansion as a per-token override).
const ELEMENT_TOKEN: Partial<Record<string, keyof ThemePalette>> = {
  diffAdded: "diffAdded",
  diffRemoved: "diffRemoved",
  diffAddedWord: "diffAdded",
  diffRemovedWord: "diffRemoved",
}

function safeParse(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Resolve the reused Claude Code palette, or null when Claude Code has no theme
 * configured (no settings file, or no `theme` key) or the config can't be read.
 */
export function readClaudeCodeTheme(opts: ClaudeThemeOptions): ThemePalette | null {
  const { osHome, read } = opts
  const settings = safeParse(read(path.join(osHome, ".claude", "settings.json")))
  if (!settings || typeof settings !== "object") return null
  const theme = (settings as { theme?: unknown }).theme
  if (typeof theme !== "string" || !theme) return null

  if (!theme.startsWith("custom:")) {
    return expandPalette(baseFor(theme))
  }

  // custom:<slug> → ~/.claude/themes/<slug>.json
  const slug = theme.slice("custom:".length)
  const custom = safeParse(read(path.join(osHome, ".claude", "themes", `${slug}.json`)))
  const base = baseFor(
    custom && typeof custom === "object" ? (custom as { base?: string }).base : undefined
  )
  const tokenOverrides: Partial<ThemePalette> = {}

  const overrides =
    custom && typeof custom === "object" ? (custom as { overrides?: unknown }).overrides : undefined
  if (overrides && typeof overrides === "object") {
    for (const [key, rawValue] of Object.entries(overrides as Record<string, unknown>)) {
      if (typeof rawValue !== "string") continue
      const color = normalizeColor(rawValue)
      if (color === null) continue
      const role = BASE_ROLE[key]
      if (role) {
        base[role] = color
        continue
      }
      const token = ELEMENT_TOKEN[key]
      if (token) tokenOverrides[token] = color
    }
  }

  return expandPalette(base, tokenOverrides)
}
