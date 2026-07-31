/**
 * Resolve the active {@link ThemePalette} from the CLI's `theme` config value.
 * The single entry point the App uses to turn a theme name into colours.
 *
 * Accepted `theme` values:
 *   - a built-in name (`cognia` | `dark` | `light` | `dark-daltonized` |
 *     `light-daltonized` | `ansi` | `mono`); the legacy `classic` resolves to `ansi`
 *   - `"claude-code"` — reuse the user's Claude Code theme ({@link readClaudeCodeTheme})
 *   - `"codex"` — reuse the user's Codex code-block highlight theme only
 *     ({@link readCodexHighlightTheme}); UI stays on the raw-ANSI `ansi` palette
 *   - `"custom:<slug>"` — our own theme at `<cogniaHome>/themes/<slug>.json`
 *
 * Anything unknown / unreadable degrades to the default {@link DEFAULT_THEME_NAME}
 * theme, so a bad value never leaves the UI uncoloured.
 */
import path from "node:path"

import { BUILTIN_THEMES, BUILTIN_THEME_NAMES, CLASSIC, getBuiltinTheme } from "./builtins"
import { readClaudeCodeTheme, type ThemeFileReader } from "./claude-code"
import { CODEX_DEFAULT_HIGHLIGHT_THEME, codexCodeOverrides, readCodexHighlightTheme } from "./codex"
import { normalizeInkColor } from "./color"
import { expandPalette, type BaseColors, type ThemePalette } from "./palette"
import type { ResolvedConfig } from "../../config/schema"

/**
 * Build a {@link BaseColors} from a user-authored `base` object, normalising each
 * role's colour value and falling back to the classic role colour for any
 * missing/unparseable role so a partial or typo'd file never leaves the UI
 * uncoloured. `text` is included only when present and valid (omit ⇒ terminal
 * default, matching classic).
 */
function normalizeBaseColors(raw: Record<string, unknown>): BaseColors {
  const role = (key: keyof BaseColors, fallback: string): string => {
    const v = raw[key]
    if (typeof v === "string") {
      const c = normalizeInkColor(v)
      if (c !== null) return c
    }
    return fallback
  }
  const base: BaseColors = {
    accent: role("accent", CLASSIC.accent),
    secondary: role("secondary", CLASSIC.secondary),
    info: role("info", CLASSIC.info),
    success: role("success", CLASSIC.success),
    warning: role("warning", CLASSIC.warning),
    danger: role("danger", CLASSIC.danger),
    muted: role("muted", CLASSIC.muted),
  }
  if (typeof raw.text === "string") {
    const t = normalizeInkColor(raw.text)
    if (t !== null) base.text = t
  }
  return base
}

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
  const { base, overrides } = parsed as {
    base?: string | Record<string, unknown>
    overrides?: Record<string, unknown>
  }
  // `base` may be a built-in theme NAME (string) or an authored BaseColors object.
  // An object is expanded through expandPalette so a single role edit (e.g. accent)
  // cascades to every derived token (border, headings, selection, …).
  const start =
    base && typeof base === "object"
      ? expandPalette(normalizeBaseColors(base))
      : getBuiltinTheme(typeof base === "string" ? base : undefined)
  if (!overrides || typeof overrides !== "object") return { ...start }
  const out: ThemePalette = { ...start }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string" || !(key in start)) continue
    const color = normalizeInkColor(value)
    if (color !== null) (out as unknown as Record<string, string>)[key] = color
  }
  return out
}

/** Resolve the active palette for the given config. Never throws. */
export function resolveTheme(config: ResolvedConfig, deps: ResolveThemeDeps): ThemePalette {
  const theme = config.theme
  // Absent ⇒ the default theme.
  if (!theme) return getBuiltinTheme(undefined)

  // A built-in name, or the legacy `classic` alias (getBuiltinTheme maps it to `ansi`).
  if (theme in BUILTIN_THEMES || theme === "classic") return getBuiltinTheme(theme)

  if (theme === "claude-code") {
    return (
      readClaudeCodeTheme({ osHome: deps.osHome, read: deps.read }) ?? getBuiltinTheme(undefined)
    )
  }

  if (theme === "codex") {
    // Codex's `tui.theme` themes only the code block + diffs; its UI chrome is
    // terminal-neutral with a cyan accent (codex-rs/tui/src/style.rs) — which our
    // `ansi` base already reproduces. So keep the UI on `ansi` and override just
    // the `code*` tokens from the user's Codex syntax theme. When Codex has no
    // explicit `tui.theme`, fall back to Codex's OWN default (catppuccin-mocha)
    // rather than our warm `cognia` default, so the reuse actually resembles
    // Codex out of the box instead of looking nothing like it.
    const name =
      readCodexHighlightTheme({ osHome: deps.osHome, read: deps.read }) ??
      CODEX_DEFAULT_HIGHLIGHT_THEME
    return { ...getBuiltinTheme("ansi"), ...codexCodeOverrides(name) }
  }

  if (theme.startsWith("custom:")) {
    return (
      readCogniaCustomTheme(deps.cogniaHome, theme.slice("custom:".length), deps.read) ??
      getBuiltinTheme(undefined)
    )
  }

  return getBuiltinTheme(undefined)
}
