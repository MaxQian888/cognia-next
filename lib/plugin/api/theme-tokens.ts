/**
 * The design-token contract plugins render against.
 *
 * The host already publishes a full token set on `:root` — colors, spacing
 * density, type scale, corner radius and a motion multiplier. React-rendered
 * plugin UI inherits all of it through the cascade for free; what was missing
 * was (a) a *documented* list, so the names are a contract we owe stability on
 * rather than an implementation detail, (b) a JavaScript-readable form, because
 * JS-driven animation cannot see CSS, and (c) any of it reaching webviews,
 * which are separate documents and inherit nothing.
 *
 * This module is the single definition all three consume.
 */

/**
 * Custom properties that make up the public plugin token contract. Renaming or
 * dropping one is a breaking change for every installed plugin's stylesheet;
 * `theme-tokens.test.ts` pins them against `app/globals.css`.
 */
export const PLUGIN_DESIGN_TOKENS = [
  // Color — surfaces and text
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--muted",
  "--muted-foreground",
  // Color — intent
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--success",
  // Chrome
  "--border",
  "--input",
  "--ring",
  "--radius",
  // Density
  "--density-spacing",
  "--density-gap",
  "--density-row-padding",
  "--density-input-height",
  "--density-line-height",
  // Typography
  "--line-height-scale",
  "--letter-spacing-em",
  // Motion
  "--motion-duration-scale",
] as const

export type PluginDesignToken = (typeof PLUGIN_DESIGN_TOKENS)[number]

/** Class the host puts on `<html>` when animation should be suppressed. */
export const REDUCE_MOTION_CLASS = "reduce-motion"

/**
 * Read the currently-applied values of the token contract off `<html>`.
 *
 * Deliberately reads computed style rather than re-deriving from the settings
 * store: density can come from a level, a theme pack, or a plugin-contributed
 * preset, and only the computed value reflects which of those actually won.
 * A plugin asking "what is applied" should get what is painted.
 */
export function readAppliedDesignTokens(): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return out
  const computed = getComputedStyle(document.documentElement)
  for (const token of PLUGIN_DESIGN_TOKENS) {
    const value = computed.getPropertyValue(token).trim()
    if (value) out[token] = value
  }
  return out
}

/**
 * Whether animation should be suppressed right now.
 *
 * Two independent sources, and missing either one is a real accessibility bug:
 * the in-app toggle writes the `reduce-motion` class, while the OS-level
 * `prefers-reduced-motion` is handled purely by a media query in `globals.css`
 * and is never mirrored into the DOM. CSS sees both; JavaScript sees neither
 * unless it checks both here.
 */
export function prefersReducedMotion(): boolean {
  if (typeof document === "undefined") return false
  if (document.documentElement.classList.contains(REDUCE_MOTION_CLASS)) return true
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    // jsdom and some embedded webviews implement matchMedia partially.
    return false
  }
}

function numericToken(tokens: Record<string, string>, name: string, fallback: number): number {
  const parsed = Number.parseFloat(tokens[name] ?? "")
  return Number.isFinite(parsed) ? parsed : fallback
}

export interface AppliedThemeTokens {
  motion: { durationScale: number; reduced: boolean }
  density: {
    level: "compact" | "comfortable" | "spacious"
    spacing: string
    gap: string
    rowPadding: string
    inputHeight: string
    lineHeight: string
  }
  typography: { lineHeightScale: number; letterSpacingEm: number }
  radius: number
}

/**
 * Project the applied tokens into the shape `ThemeState` exposes to plugins.
 * `level` is not a CSS variable — the density applier writes it as a data
 * attribute — so it is read from there and defaults to the app default.
 */
export function readAppliedThemeTokens(): AppliedThemeTokens {
  const tokens = readAppliedDesignTokens()
  const level =
    typeof document !== "undefined" ? document.documentElement.getAttribute("data-density") : null

  return {
    motion: {
      durationScale: numericToken(tokens, "--motion-duration-scale", 1),
      reduced: prefersReducedMotion(),
    },
    density: {
      level:
        level === "compact" || level === "spacious" || level === "comfortable"
          ? level
          : "comfortable",
      spacing: tokens["--density-spacing"] ?? "",
      gap: tokens["--density-gap"] ?? "",
      rowPadding: tokens["--density-row-padding"] ?? "",
      inputHeight: tokens["--density-input-height"] ?? "",
      lineHeight: tokens["--density-line-height"] ?? "",
    },
    typography: {
      lineHeightScale: numericToken(tokens, "--line-height-scale", 1),
      letterSpacingEm: numericToken(tokens, "--letter-spacing-em", 0),
    },
    radius: numericToken(tokens, "--radius", 0.625),
  }
}

/**
 * Serialize the token contract as a CSS rule for injection into a webview.
 *
 * A webview is a separate document behind an opaque-origin sandbox, so it
 * inherits nothing from the host — without this a webview panel renders with
 * browser defaults next to native UI. Values are the host's *computed* ones, so
 * the webview gets concrete values rather than unresolvable `var()` chains.
 */
export function buildWebviewTokenCss(
  tokens: Record<string, string> = readAppliedDesignTokens(),
  reducedMotion: boolean = prefersReducedMotion()
): string {
  const declarations = Object.entries(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n")
  const reduceRule = reducedMotion
    ? "\n*, *::before, *::after {\n  animation-duration: 1ms !important;\n  animation-iteration-count: 1 !important;\n  transition-duration: 1ms !important;\n}"
    : ""
  return `:root {\n${declarations}\n}${reduceRule}`
}
