/**
 * Projects the app's live appearance + editor preferences into code-server's own
 * `settings.json`, so the embedded Pro IDE looks and behaves like part of cognia
 * instead of a foreign app bolted into the pane.
 *
 * Mechanism: plain user settings, not a generated theme extension. VS Code's
 * `WorkbenchThemeService` watches `workbench.colorCustomizations` and re-applies
 * it through `updateDynamicCSSRules()` with no window reload, and it accepts the
 * full Theme Color reference set — so one settings write repaints a live
 * workbench. A theme extension would need a reload (extensions are discovered at
 * startup) and buys nothing extra. The `editor.*` / `terminal.integrated.*` keys
 * are likewise hot-applied.
 *
 * Syntax highlighting is deliberately left to the base theme
 * (`workbench.colorTheme`): the app palette has no token colors, exactly as the
 * Monaco counterpart `lib/canvas/themes/cognia-active-theme.ts` inherits its
 * base theme's `tokenColors`. We only own the chrome.
 *
 * The color table lives in `./vscode-chrome-map` — see its header for why export
 * does NOT reuse the importer's sampling table.
 */
import { formatHex, parse as parseCulori } from "culori"

import { stripJsonComments } from "@/lib/appearance/vscode-theme/parse-json"
import { DEFAULT_FALLBACKS } from "@/lib/appearance/vscode-theme/token-mapping"
import { VSCODE_CHROME_MAP } from "@/lib/codeserver/theme/vscode-chrome-map"
import type { CanvasAccessibilitySettings, CanvasEditorSettings } from "@/types/canvas/settings"
import type { MotionSettings } from "@/types/appearance"
import type { ThemeColors } from "@/types/plugin/plugin"

const HEX_6 = /^#[0-9a-fA-F]{6}$/

/**
 * The settings keys this module owns. Everything else in the user's
 * `settings.json` — including anything they set from inside VS Code — is
 * preserved by {@link mergeCodeServerSettings}.
 *
 * Listed rather than derived so that *removing* a key from
 * {@link buildCodeServerSettings} still clears the stale value it wrote on a
 * previous run: the merge drops every managed key before re-adding the current
 * set. A derived list would leave orphans behind forever.
 */
export const CODESERVER_MANAGED_SETTING_KEYS = [
  // Theme
  "workbench.colorTheme",
  "workbench.colorCustomizations",
  "window.autoDetectColorScheme",
  "window.autoDetectHighContrast",
  "workbench.startupEditor",
  "workbench.secondarySideBar.defaultVisibility",
  // Editor typography + layout
  "editor.fontFamily",
  "editor.fontSize",
  "editor.fontLigatures",
  "editor.letterSpacing",
  "editor.lineHeight",
  "editor.tabSize",
  "editor.insertSpaces",
  "editor.wordWrap",
  "editor.minimap.enabled",
  "editor.minimap.scale",
  "editor.lineNumbers",
  "editor.renderWhitespace",
  "editor.renderLineHighlight",
  "editor.scrollBeyondLastLine",
  "editor.stickyScroll.enabled",
  "editor.stickyScroll.maxLineCount",
  "editor.folding",
  "editor.showFoldingControls",
  "editor.padding.top",
  "editor.padding.bottom",
  "editor.guides.indentation",
  "editor.guides.bracketPairs",
  "editor.bracketPairColorization.enabled",
  // Editor behaviour
  "editor.inlineSuggest.enabled",
  "editor.autoClosingBrackets",
  "editor.autoClosingQuotes",
  "editor.formatOnPaste",
  "editor.formatOnType",
  "editor.mouseWheelZoom",
  // Motion + a11y
  "editor.cursorStyle",
  "editor.cursorBlinking",
  "editor.cursorSmoothCaretAnimation",
  "editor.smoothScrolling",
  "editor.accessibilitySupport",
  "workbench.reduceMotion",
  "workbench.list.smoothScrolling",
  "terminal.integrated.smoothScrolling",
  // Terminal typography (mirrors the editor's — code-server has no separate
  // app-side terminal-font preference to draw on)
  "terminal.integrated.fontFamily",
  "terminal.integrated.fontSize",
  "terminal.integrated.cursorStyle",
  "terminal.integrated.cursorBlinking",
  // Noise suppression for an embedded pane
  "telemetry.telemetryLevel",
  "update.mode",
  "workbench.tips.enabled",
  "workbench.enableExperiments",
] as const

/**
 * The colour-owning subset of {@link CODESERVER_MANAGED_SETTING_KEYS}.
 *
 * Split out because editor-link can be turned off (Settings → Appearance →
 * Advanced → editor link, the same switch that governs Monaco). When it is off
 * the app must stop *both* writing these keys and sweeping them, or the user's
 * own in-VS-Code theme pick would be deleted on the next sync of the non-colour
 * settings — "stop driving my theme" would read as "delete my theme".
 */
export const CODESERVER_THEME_SETTING_KEYS = [
  "workbench.colorTheme",
  "workbench.colorCustomizations",
  "window.autoDetectColorScheme",
  "window.autoDetectHighContrast",
] as const

/**
 * Base themes whose syntax colors we inherit under our chrome overrides.
 *
 * The high-contrast pair matters: when the app is in a11y high-contrast mode the
 * chrome overrides alone would leave VS Code's *syntax* colors at normal
 * contrast, which is precisely the population that can't read them. VS Code's own
 * high-contrast themes ship contrast-checked token colors, so we switch the base
 * rather than trying to synthesise one.
 */
const BASE_THEME = {
  dark: "Default Dark Modern",
  light: "Default Light Modern",
  highContrastDark: "Default High Contrast",
  highContrastLight: "Default High Contrast Light",
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

/** Append an `AA` alpha byte to a `#RRGGBB`. `alpha` is clamped to 0..1. */
function withAlpha(hex6: string, alpha: number): string {
  const clamped = Math.min(1, Math.max(0, alpha))
  const byte = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, "0")
  return `${hex6}${byte}`
}

/**
 * Build a VS Code `workbench.colorCustomizations` object from the app palette.
 *
 * One key per entry in {@link VSCODE_CHROME_MAP} — no collision resolution and
 * no "first writer wins", because the table is keyed by the VS Code key rather
 * than by the palette slot. Overlay surfaces get an `#RRGGBBAA` value so they
 * tint what is behind them instead of painting over it.
 */
export function buildCodeServerColorCustomizations(
  colors: ThemeColors,
  variant: "light" | "dark"
): Record<string, string> {
  const fallbacks = DEFAULT_FALLBACKS[variant]
  const out: Record<string, string> = {}
  for (const [key, source] of Object.entries(VSCODE_CHROME_MAP)) {
    const hex = toHex6(
      colors[source.token] ?? fallbacks[source.token] ?? "",
      fallbacks[source.token] ?? ""
    )
    out[key] = source.alpha === undefined ? hex : withAlpha(hex, source.alpha)
  }
  return out
}

export interface CodeServerSettingsInput {
  colors: ThemeColors
  variant: "light" | "dark"
  /** True while the app is in a11y high-contrast mode (picks the base theme). */
  highContrast?: boolean
  /**
   * The app's own editor preferences (Settings → Canvas/Editor), the same slice
   * that drives Monaco via `useCanvasSettingsStore.getEditorOptions`. Mirroring
   * it is what makes the two engines *behave* alike, not merely match in color.
   */
  editor?: CanvasEditorSettings
  /** Editor a11y slice — drives `accessibilitySupport` + the motion overrides. */
  accessibility?: CanvasAccessibilitySettings
  /** Appearance motion slice; `reduce` collapses every workbench animation. */
  motion?: MotionSettings
  /**
   * Whether the app palette drives the editor's colours (the unified editor-link
   * switch). `false` leaves the theme entirely to VS Code — the non-colour
   * settings below still sync, because those are preferences the user set in
   * cognia and never in VS Code. Defaults to `true`.
   */
  linkTheme?: boolean
}

/**
 * The settings object cognia manages for the embedded editor.
 *
 * Everything is emitted unconditionally (rather than only-when-non-default) so a
 * user who changed a mirrored setting from *inside* VS Code sees the app's value
 * win back on the next sync. Settings we do not list are never touched — see
 * {@link mergeCodeServerSettings}.
 */
export function buildCodeServerSettings(input: CodeServerSettingsInput): Record<string, unknown> {
  const { variant, highContrast, editor, accessibility, motion } = input
  const linkTheme = input.linkTheme ?? true
  const baseTheme = highContrast
    ? variant === "dark"
      ? BASE_THEME.highContrastDark
      : BASE_THEME.highContrastLight
    : BASE_THEME[variant]

  // Reduced motion has two independent sources: the appearance slice (Settings →
  // Appearance → Motion) and the editor a11y slice. Either one asking for calm
  // wins — a user who set it in one place did not mean "unless the other place
  // disagrees".
  const reduceMotion = motion?.reduce === true || accessibility?.reducedMotion === true

  const settings: Record<string, unknown> = {
    // A Welcome tab is noise in a pane the user opened to look at one project.
    "workbench.startupEditor": "none",
    // VS Code otherwise opens workspace-scoped AI/chat views in the right-side
    // Secondary Side Bar. Keep the embedded editor focused by default; users
    // can still reveal it from View → Appearance when they want it.
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "workbench.reduceMotion": reduceMotion ? "on" : "off",
    "workbench.list.smoothScrolling": !reduceMotion,
    "terminal.integrated.smoothScrolling": !reduceMotion,
    "editor.accessibilitySupport": accessibility?.screenReaderOptimized ? "on" : "auto",
    // An embedded pane has no business phoning home or offering to update itself
    // — the app pins and manages the code-server version.
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "workbench.tips.enabled": false,
    "workbench.enableExperiments": false,
  }

  if (linkTheme) {
    settings["workbench.colorTheme"] = baseTheme
    settings["workbench.colorCustomizations"] = buildCodeServerColorCustomizations(
      input.colors,
      variant
    )
    // The app owns light/dark and high contrast; letting VS Code also react to
    // the OS would fight the sync on every system-theme flip.
    settings["window.autoDetectColorScheme"] = false
    settings["window.autoDetectHighContrast"] = false
  }

  if (editor) {
    Object.assign(settings, {
      "editor.fontFamily": editor.fontFamily,
      "editor.fontSize": editor.fontSize,
      "editor.fontLigatures": editor.fontLigatures,
      "editor.letterSpacing": editor.letterSpacing,
      "editor.lineHeight": editor.lineHeight,
      "editor.tabSize": editor.tabSize,
      "editor.insertSpaces": editor.insertSpaces,
      // Monaco's boolean maps onto VS Code's enum.
      "editor.wordWrap": editor.wordWrap ? "on" : "off",
      "editor.minimap.enabled": editor.minimap,
      "editor.minimap.scale": editor.minimapScale,
      "editor.lineNumbers": editor.lineNumbers,
      "editor.renderWhitespace": editor.renderWhitespace,
      "editor.renderLineHighlight": editor.renderLineHighlight,
      "editor.scrollBeyondLastLine": editor.scrollBeyondLastLine,
      "editor.stickyScroll.enabled": editor.stickyScroll,
      "editor.stickyScroll.maxLineCount": editor.stickyScrollMaxLines,
      "editor.folding": editor.folding,
      "editor.showFoldingControls": editor.showFoldingControls,
      "editor.padding.top": editor.padding.top,
      "editor.padding.bottom": editor.padding.bottom,
      "editor.guides.indentation": editor.guides.indentation,
      "editor.guides.bracketPairs": editor.guides.bracketPairs,
      "editor.bracketPairColorization.enabled": editor.bracketPairColorization,
      "editor.inlineSuggest.enabled": editor.inlineSuggest,
      "editor.autoClosingBrackets": editor.autoClosingBrackets ? "languageDefined" : "never",
      "editor.autoClosingQuotes": editor.autoClosingQuotes ? "languageDefined" : "never",
      "editor.formatOnPaste": editor.formatOnPaste,
      "editor.formatOnType": editor.formatOnType,
      "editor.mouseWheelZoom": editor.mouseWheelZoom,
      "editor.cursorStyle": editor.cursorStyle,
      // Reduced motion overrides the animated cursor / scroll settings rather
      // than letting the editor slice reintroduce animation the user turned off.
      "editor.cursorBlinking": reduceMotion ? "solid" : editor.cursorBlinking,
      "editor.cursorSmoothCaretAnimation": reduceMotion ? "off" : editor.cursorSmoothCaretAnimation,
      "editor.smoothScrolling": reduceMotion ? false : editor.smoothScrolling,
      // The app has no separate terminal-font preference for the Pro IDE, and an
      // embedded terminal that disagrees with the editor above it reads as a
      // different application. Mirror the editor's typography.
      "terminal.integrated.fontFamily": editor.fontFamily,
      "terminal.integrated.fontSize": editor.fontSize,
      "terminal.integrated.cursorStyle": editor.cursorStyle,
      "terminal.integrated.cursorBlinking": reduceMotion
        ? false
        : editor.cursorBlinking !== "solid",
    })
  } else {
    // No editor slice available (never hydrated): still pin the motion-derived
    // keys, which are the ones an a11y user actually depends on.
    Object.assign(settings, {
      "editor.cursorBlinking": reduceMotion ? "solid" : "blink",
      "editor.cursorSmoothCaretAnimation": reduceMotion ? "off" : "explicit",
      "editor.smoothScrolling": !reduceMotion,
    })
  }

  return settings
}

/**
 * Fold `managed` into the user's existing `settings.json` text.
 *
 * Tolerates the JSONC that VS Code itself writes (comments, via the importer's
 * {@link stripJsonComments}) and an unparseable file, which is treated as empty
 * rather than aborting the sync. Comments do not survive the round-trip — we
 * re-serialize as plain JSON — but every unmanaged key does.
 *
 * Managed keys are cleared before `managed` is applied, so a key this module
 * stopped emitting does not linger from an older app version. `preserve` opts
 * specific managed keys out of that sweep — used for the theme keys while the
 * editor link is off, where "we no longer drive this" must not mean "we delete
 * whatever the user chose instead".
 */
export function mergeCodeServerSettings(
  existingRaw: string,
  managed: Record<string, unknown>,
  options: { preserve?: readonly string[] } = {}
): string {
  let existing: Record<string, unknown> = {}
  const trimmed = existingRaw.trim()
  if (trimmed) {
    try {
      const parsed: unknown = JSON.parse(stripJsonComments(existingRaw))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = { ...(parsed as Record<string, unknown>) }
      }
    } catch {
      // Corrupt or hand-broken file — better to rewrite it than to leave the
      // editor unthemed forever.
    }
  }
  const preserved = new Set(options.preserve ?? [])
  for (const key of CODESERVER_MANAGED_SETTING_KEYS) {
    if (!preserved.has(key)) delete existing[key]
  }
  return `${JSON.stringify({ ...existing, ...managed }, null, 2)}\n`
}
