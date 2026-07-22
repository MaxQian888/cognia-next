/**
 * Projects the app's active appearance palette into code-server's own
 * `settings.json`, so the embedded Pro IDE looks like part of cognia instead of
 * a foreign app bolted into the pane.
 *
 * Mechanism: `workbench.colorCustomizations`, not a generated theme extension.
 * VS Code's `WorkbenchThemeService` watches that setting and re-applies it
 * through `updateDynamicCSSRules()` with no window reload, and it accepts the
 * full Theme Color reference set — so one settings write repaints a live
 * workbench. A theme extension would need a reload (extensions are discovered at
 * startup) and buys nothing extra.
 *
 * Syntax highlighting is deliberately left to the base theme
 * (`workbench.colorTheme`): the app palette has no token colors, exactly as the
 * Monaco counterpart `lib/canvas/themes/cognia-active-theme.ts` inherits its
 * base theme's `tokenColors`. We only own the chrome.
 *
 * The color map itself is NOT hand-authored — it is the inverse of
 * `lib/appearance/vscode-theme/token-mapping.ts`, the same curated table the
 * VS Code theme *importer* uses. One table, both directions.
 */
import { formatHex, parse as parseCulori } from "culori"

import { stripJsonComments } from "@/lib/appearance/vscode-theme/parse-json"
import {
  DEFAULT_FALLBACKS,
  THEME_COLOR_KEYS,
  VSCODE_COLOR_MAP,
} from "@/lib/appearance/vscode-theme/token-mapping"
import type { ThemeColors } from "@/types/plugin/plugin"

const HEX_6 = /^#[0-9a-fA-F]{6}$/

/**
 * The settings keys this module owns. Everything else in the user's
 * `settings.json` — including anything they set from inside VS Code — is
 * preserved by {@link mergeCodeServerSettings}.
 */
export const CODESERVER_MANAGED_SETTING_KEYS = [
  "workbench.colorTheme",
  "workbench.colorCustomizations",
  "workbench.startupEditor",
] as const

/** Base themes whose syntax colors we inherit under our chrome overrides. */
const BASE_THEME = {
  dark: "Default Dark Modern",
  light: "Default Light Modern",
} as const

/**
 * Any CSS color (the palette stores oklch for custom themes, hex for presets)
 * to a 6-digit hex, which is what VS Code's color parser accepts.
 */
function toHex6(value: string | undefined, fallback: string): string {
  if (!value) return fallback
  try {
    const parsed = parseCulori(value)
    const hex = parsed ? formatHex(parsed) : null
    if (hex && HEX_6.test(hex)) return hex
  } catch {
    // Unparseable custom value — fall through to the variant default.
  }
  return fallback
}

/**
 * Invert `VSCODE_COLOR_MAP` into a VS Code `workbench.colorCustomizations`
 * object.
 *
 * Several app tokens legitimately list the same VS Code key (e.g.
 * `panel.background` appears under both `secondary` and `card`). Import
 * resolves that with "first non-empty wins"; export mirrors it by walking
 * `THEME_COLOR_KEYS` in its declared order and letting the first token to claim
 * a key keep it — so `editor.background` comes from `background`, not from
 * `card` or `destructiveForeground`.
 */
export function buildCodeServerColorCustomizations(
  colors: ThemeColors,
  variant: "light" | "dark"
): Record<string, string> {
  const fallbacks = DEFAULT_FALLBACKS[variant]
  const out: Record<string, string> = {}
  for (const token of THEME_COLOR_KEYS) {
    const hex = toHex6(colors[token], fallbacks[token])
    for (const key of VSCODE_COLOR_MAP[token]) {
      if (!(key in out)) out[key] = hex
    }
  }
  return out
}

export interface CodeServerSettingsInput {
  colors: ThemeColors
  variant: "light" | "dark"
}

/**
 * The settings object cognia manages for the embedded editor.
 *
 * Font is deliberately absent: `AppSettings` has no editor-font preference (the
 * only `fontFamily` / `fontSize` it carries belong to the integrated terminal),
 * so there is nothing to mirror. Adding the keys anyway would either invent a
 * setting or quietly impose terminal typography on the editor.
 */
export function buildCodeServerSettings(input: CodeServerSettingsInput): Record<string, unknown> {
  return {
    "workbench.colorTheme": BASE_THEME[input.variant],
    "workbench.colorCustomizations": buildCodeServerColorCustomizations(
      input.colors,
      input.variant
    ),
    // A Welcome tab is noise in a pane the user opened to look at one project.
    "workbench.startupEditor": "none",
  }
}

/**
 * Fold `managed` into the user's existing `settings.json` text.
 *
 * Tolerates the JSONC that VS Code itself writes (comments, via the importer's
 * {@link stripJsonComments}) and an unparseable file, which is treated as empty
 * rather than aborting the sync. Comments do not survive the round-trip — we
 * re-serialize as plain JSON — but every unmanaged key does.
 */
export function mergeCodeServerSettings(
  existingRaw: string,
  managed: Record<string, unknown>
): string {
  let existing: Record<string, unknown> = {}
  const trimmed = existingRaw.trim()
  if (trimmed) {
    try {
      const parsed: unknown = JSON.parse(stripJsonComments(existingRaw))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>
      }
    } catch {
      // Corrupt or hand-broken file — better to rewrite it than to leave the
      // editor unthemed forever.
    }
  }
  return `${JSON.stringify({ ...existing, ...managed }, null, 2)}\n`
}
