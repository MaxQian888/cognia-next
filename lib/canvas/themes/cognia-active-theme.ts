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
 *
 * `syncCogniaActiveTheme` overlays the surface tokens the page is ACTUALLY
 * painted with (computed `--background` / `--foreground` / … on `<html>`) on
 * top of the palette its caller resolved, and keeps re-syncing as the DOM
 * changes. The resolved palette alone is not what the user sees: the default
 * preset resolves to the navy `NEUTRAL_DARK` ground while the DOM defers to the
 * neutral `globals.css` rules, and plugin themes paint through a `<style>`
 * block no palette resolver sees — either way the editor sat in a visibly
 * different colour from the dock around it.
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

export interface CogniaActiveThemeOptions {
  /**
   * A wallpaper paints behind editors (`globals.css` then clears the editor
   * and gutter backgrounds). Only the minimap — a `<canvas>` CSS cannot clear —
   * needs the theme's help: it goes translucent instead of opaque.
   */
  wallpaperBehind?: boolean
}

/**
 * Build the editor theme that matches the user's current appearance palette.
 * Pure: no DOM or Monaco side effects.
 */
export function buildCogniaActiveEditorTheme(
  appearance: AppearanceColors,
  variant: "light" | "dark",
  options: CogniaActiveThemeOptions = {}
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
    // The minimap is a <canvas> layered OVER the view lines: with word wrap
    // off, a long line runs on underneath it. Its clear colour must therefore
    // stay opaque, or the code behind bleeds through the minimap. Under a
    // wallpaper CSS clears the editor itself; the minimap (whose pixels CSS
    // cannot reach) goes 80% opaque — the wallpaper tints through while bled
    // text stays faint enough not to read.
    minimap: options.wallpaperBehind ? withAlpha(bg, "cc") : bg,
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
 * The surface tokens read back from the live DOM. Only surfaces: the default
 * preset's `--primary` / `--accent` are near-white / near-black neutrals meant
 * for buttons, which would wash out selections and find matches, so the
 * caller's resolved accents stay authoritative for those.
 */
const LIVE_SURFACE_TOKENS = {
  background: "--background",
  foreground: "--foreground",
  mutedForeground: "--muted-foreground",
  border: "--border",
} as const satisfies Partial<Record<keyof AppearanceColors, `--${string}`>>

/** Wallpaper scopes whose `globals.css` rules clear Monaco's background. */
const EDITOR_WALLPAPER_SCOPES = new Set(["canvas", "all", "global"])

/**
 * Read the surface colours `<html>` is painted with right now. Empty (no DOM,
 * or the variables are unset) leaves the caller's palette untouched.
 */
export function readLiveSurfaceColors(): Partial<AppearanceColors> {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return {}
  const style = getComputedStyle(document.documentElement)
  const out: Partial<AppearanceColors> = {}
  for (const [key, cssVar] of Object.entries(LIVE_SURFACE_TOKENS) as Array<
    [keyof typeof LIVE_SURFACE_TOKENS, string]
  >) {
    const value = style.getPropertyValue(cssVar).trim()
    if (value) out[key] = value
  }
  return out
}

/**
 * Whether a wallpaper is painting behind editors — the same `<body>` attributes
 * the `globals.css` editor-transparency rules key on (`BackgroundApplier`
 * writes them).
 */
export function isWallpaperBehindEditors(): boolean {
  if (typeof document === "undefined" || !document.body) return false
  const { body } = document
  return (
    body.getAttribute("data-bg-enabled") === "true" &&
    EDITOR_WALLPAPER_SCOPES.has(body.getAttribute("data-bg-scope") ?? "")
  )
}

interface ActiveSync {
  monaco: MonacoNamespace
  appearance: AppearanceColors
  variant: "light" | "dark"
}

// `cognia-active` is ONE theme on the shared Monaco namespace, so the latest
// sync is the one the live-DOM watcher keeps current.
let activeSync: ActiveSync | null = null
let lastDefined: string | null = null
let observer: MutationObserver | null = null
let pendingFrame: number | null = null

function defineActiveTheme(force: boolean): void {
  if (!activeSync) return
  const { monaco, appearance, variant } = activeSync
  const theme = buildCogniaActiveEditorTheme(
    { ...appearance, ...readLiveSurfaceColors() },
    variant,
    {
      wallpaperBehind: isWallpaperBehindEditors(),
    }
  )
  const definition = themeRegistry.toMonacoTheme(theme)
  const serialized = JSON.stringify(definition)
  // Monaco rewrites its own <style> on every defineTheme — the watcher sees
  // that too, so an unchanged result must not redefine (or it would loop).
  if (!force && serialized === lastDefined) return
  lastDefined = serialized
  themeRegistry.registerTheme(theme)
  // Redefining the active theme repaints every editor using it in place.
  monaco.editor.defineTheme(COGNIA_ACTIVE_THEME_ID, definition)
}

/**
 * Re-sync when the painted palette moves without the caller re-running: a
 * light/dark flip lands in next-themes' ancestor effect AFTER the editors'
 * effects read the DOM, plugin themes swap a `<style>` block, and the
 * wallpaper toggles `<body>` attributes. Coalesced to one pass per frame.
 */
function ensureLiveDomWatcher(): void {
  if (observer || typeof MutationObserver === "undefined" || typeof document === "undefined") {
    return
  }
  const schedule = () => {
    if (pendingFrame !== null) return
    const run = () => {
      pendingFrame = null
      defineActiveTheme(false)
    }
    pendingFrame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(run)
        : (setTimeout(run, 16) as unknown as number)
  }
  observer = new MutationObserver(schedule)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  })
  if (document.head) {
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  }
  if (document.body) {
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-bg-enabled", "data-bg-scope"],
    })
  }
}

/**
 * Build, register on the shared `themeRegistry`, and install on Monaco under
 * the stable id `"cognia-active"`, with the live DOM surfaces overlaid on
 * `appearance`. Idempotent — both `registerTheme` and `defineTheme` are
 * Map.set semantics, so re-syncing on every token change just overwrites in
 * place. The first call also starts the live-DOM watcher.
 */
export function syncCogniaActiveTheme(
  monaco: MonacoNamespace,
  appearance: AppearanceColors,
  variant: "light" | "dark"
): void {
  activeSync = { monaco, appearance, variant }
  defineActiveTheme(true)
  ensureLiveDomWatcher()
}

/** Test seam: drop the module-level sync state and the DOM watcher. */
export function resetCogniaActiveThemeSyncForTests(): void {
  observer?.disconnect()
  observer = null
  if (pendingFrame !== null) {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(pendingFrame)
    clearTimeout(pendingFrame)
  }
  pendingFrame = null
  activeSync = null
  lastDefined = null
}
