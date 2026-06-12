/**
 * Resolve the active {@link ThemePalette} from the CLI's `theme` config value.
 * The single entry point the App uses to turn a theme name into colours.
 *
 * Accepted `theme` values:
 *   - a built-in name (`classic` | `dark` | `light` | `dark-daltonized` |
 *     `light-daltonized` | `mono`)
 *   - `"claude-code"` — reuse the user's Claude Code theme ({@link readClaudeCodeTheme})
 *   - `"codex"` — reuse the user's Codex code-block highlight theme only
 *     ({@link readCodexHighlightTheme}); UI stays on `classic`
 *   - `"custom:<slug>"` — our own theme at `<cogniaHome>/themes/<slug>.json`
 *
 * Anything unknown / unreadable degrades to `classic`, so a bad value never
 * leaves the UI uncoloured.
 */
import path from "node:path"

import { BUILTIN_THEMES, BUILTIN_THEME_NAMES, getBuiltinTheme } from "./builtins"
import { readClaudeCodeTheme, type ThemeFileReader } from "./claude-code"
import { codexCodeOverrides, readCodexHighlightTheme } from "./codex"
import { normalizeColor } from "./color"
import type { ThemePalette } from "./palette"
import type { ResolvedConfig } from "../../config/schema"

export interface ResolveThemeDeps {
  /** OS home (`~`) — where Claude Code (`.claude`) and Codex (`.codex`) live. */
  osHome: string
  /** CLI home (`~/.cognia`) — where our own `themes/<slug>.json` live. */
  cogniaHome: string
  read: ThemeFileReader
}

/** The reuse pseudo-themes, surfaced alongside built-ins in the picker. */
export const REUSE_THEME_NAMES = ["claude-code", "codex"] as const

/** All selectable theme names for the `/theme` picker (excludes `custom:*`). */
export const THEME_CHOICES: readonly string[] = [...BUILTIN_THEME_NAMES, ...REUSE_THEME_NAMES]

/** Read our own custom theme: `{ base?, overrides? }` over a built-in palette. */
function readCogniaCustomTheme(
  cogniaHome: string,
  slug: string,
  read: ThemeFileReader
): ThemePalette | null {
  const raw = read(path.join(cogniaHome, "themes", `${slug}.json`))
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const { base, overrides } = parsed as { base?: string; overrides?: Record<string, unknown> }
  const start = getBuiltinTheme(base)
  if (!overrides || typeof overrides !== "object") return { ...start }
  const out: ThemePalette = { ...start }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string" || !(key in start)) continue
    const color = normalizeColor(value)
    if (color !== null) (out as Record<string, string>)[key] = color
  }
  return out
}

/** Resolve the active palette for the given config. Never throws. */
export function resolveTheme(config: ResolvedConfig, deps: ResolveThemeDeps): ThemePalette {
  const theme = config.theme
  if (!theme) return getBuiltinTheme("classic")

  if (theme in BUILTIN_THEMES) return getBuiltinTheme(theme)

  if (theme === "claude-code") {
    return (
      readClaudeCodeTheme({ osHome: deps.osHome, read: deps.read }) ?? getBuiltinTheme("classic")
    )
  }

  if (theme === "codex") {
    const name = readCodexHighlightTheme({ osHome: deps.osHome, read: deps.read })
    if (!name) return getBuiltinTheme("classic")
    return { ...getBuiltinTheme("classic"), ...codexCodeOverrides(name) }
  }

  if (theme.startsWith("custom:")) {
    return (
      readCogniaCustomTheme(deps.cogniaHome, theme.slice("custom:".length), deps.read) ??
      getBuiltinTheme("classic")
    )
  }

  return getBuiltinTheme("classic")
}
