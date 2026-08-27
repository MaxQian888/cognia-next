/**
 * The single answer to "which colors is the app painted in right now".
 *
 * Before this module every consumer of the live palette re-implemented the
 * layering, and they all disagreed:
 *
 *  - `CustomThemeApplier` (the DOM, i.e. the truth) layered high-contrast →
 *    preset/custom + accent → colorblind → contrast hardening;
 *  - `shell-sync` (native window / status bar) applied only preset/custom +
 *    accent, so a high-contrast or colorblind user got a normally-tinted shell;
 *  - `use-code-server-theme-sync` (Pro IDE) applied preset/custom **without**
 *    accent, so the embedded editor missed the accent override *and* all three
 *    a11y layers;
 *  - a directly-activated plugin theme was invisible to every consumer except
 *    the DOM, because it paints through a `<style>` block rather than
 *    `ThemeColors`.
 *
 * That divergence is the whole reason the Pro IDE looked like a foreign app.
 * One function, one layering order, every consumer.
 *
 * Pure: no DOM, no store subscription, no IPC. Callers own the subscription and
 * pass the appearance slice in — which is also what makes the layering testable
 * without mounting React.
 */
import { colorblindThemeOverrides } from "@/lib/appearance/colorblind-palettes"
import { ensureForegroundContrast } from "@/lib/appearance/ensure-contrast"
import { highContrastOverride } from "@/lib/appearance/high-contrast-presets"
import { themeKeyToCssVar } from "@/lib/appearance/css-var"
import { THEME_COLOR_KEYS, normalizeThemeColors } from "@/lib/appearance/theme-token-catalog"
import { resolveActiveThemeColors } from "@/lib/themes"
import type { A11ySettings } from "@/types/appearance"
import type {
  ColorThemePreset,
  CustomTheme,
  ResolvedThemeColors,
  ThemeColors,
} from "@/types/plugin/plugin"

/**
 * Minimal shape of a registered plugin theme this module can read. Structurally
 * compatible with `lib/theme/theme-registry`'s `PluginTheme` but declared here
 * so the pure resolver never imports the registry (which pulls in the plugin
 * runtime). Callers pass the already-looked-up row.
 */
export interface PluginThemeSnapshot {
  /** Structured palette, when the theme declared one. Preferred over `variables`. */
  colors?: ThemeColors
  /** CSS-variable map (`--background` → value) for `cssVariables` themes. */
  variables?: Record<string, string>
  cssVars?: Record<string, string>
}

export interface AppPaletteInput {
  colorTheme: ColorThemePreset
  /** Resolved light/dark from next-themes. Anything but `"light"` reads as dark. */
  resolvedTheme: "light" | "dark" | string | undefined
  activeCustomThemeId: string | null
  customThemes: CustomTheme[]
  accentColor?: string | null
  a11y?: A11ySettings
  /**
   * The *resolved* active plugin theme, when `settings.activePluginThemeId` points
   * at one that is still registered. Passing the row rather than the id keeps this
   * module free of the plugin registry; a caller with no access to it (or with the
   * pointer dangling) passes nothing and gets the preset/custom answer, which is
   * exactly what the DOM falls back to in that case.
   */
  pluginTheme?: PluginThemeSnapshot | null
}

export interface ResolvedAppPalette {
  /**
   * All 56 tokens, concrete. Consumers outside the DOM (native shell, Pro IDE)
   * have no stylesheet to defer to, and the editor needs a value to show in
   * every swatch — "undefined, work it out yourself" is not an answer any of
   * them can act on.
   */
  colors: ResolvedThemeColors
  variant: "light" | "dark"
  /** Which layer produced the base palette, before a11y patches. */
  source: "preset" | "custom" | "plugin" | "high-contrast"
  /** True while `a11y.highContrast` is forcing the palette. */
  highContrast: boolean
  colorblind: NonNullable<A11ySettings["colorblindMode"]>
}

/**
 * Read a `ThemeColors` back out of a plugin theme's CSS-variable map.
 *
 * `cssVariables` plugin themes carry no structured palette — only `--background`
 * style declarations — and the registry's own note says consumers should avoid
 * reverse-parsing them. That advice holds for *guessing*; this is not a guess:
 * the map is keyed by exactly {@link themeKeyToCssVar}'s output, so inverting it
 * over {@link THEME_COLOR_KEYS} is lossless for every token the theme declared.
 * Tokens it didn't declare stay absent and the caller's baseline fills them.
 *
 * It now recognises all 56 tokens, not just the original 27 — which is what
 * lets "edit a copy" of a CSS-var plugin theme lift the author's chart and
 * workflow colours into structured tokens the editor can actually show,
 * instead of leaving them stranded in an opaque `cssVars` blob.
 */
export function pluginThemeColors(theme: PluginThemeSnapshot): Partial<ThemeColors> {
  if (theme.colors) return theme.colors
  const vars = { ...(theme.variables ?? {}), ...(theme.cssVars ?? {}) }
  const out: Partial<ThemeColors> = {}
  for (const token of THEME_COLOR_KEYS) {
    const value = vars[themeKeyToCssVar(token)]
    if (typeof value === "string" && value.trim().length > 0) out[token] = value.trim()
  }
  return out
}

/**
 * Resolve the palette the app is currently painted in.
 *
 * Layering order — deliberately identical to `CustomThemeApplier`, which is the
 * consumer whose output the user actually sees:
 *
 *  1. base — a directly-activated plugin theme, else the preset/custom theme
 *     resolved by `resolveActiveThemeColors` (which also applies the standalone
 *     accent override and derives the sidebar slots);
 *  2. high contrast — when enabled it *replaces* the base entirely;
 *  3. colorblind — patches the signal tokens on top of whichever base won;
 *  4. contrast hardening — nudges any foreground that clashes with its surface
 *     to WCAG AA.
 *
 * Step 4 runs unconditionally here, unlike in `CustomThemeApplier` where the
 * default preset short-circuits to the `globals.css` rules and never reaches it.
 * That is not a divergence: the short-circuit is a DOM-write optimisation, and
 * hardening a palette that already passes AA is a no-op. Non-DOM consumers
 * (native shell, Pro IDE) have no stylesheet to defer to and need concrete
 * values for every token, always.
 */
export function resolveAppPalette(input: AppPaletteInput): ResolvedAppPalette {
  const variant: "light" | "dark" = input.resolvedTheme === "light" ? "light" : "dark"
  const highContrast = input.a11y?.highContrast ?? "off"
  const colorblind = input.a11y?.colorblindMode ?? "off"

  const hcOverride = highContrastOverride(highContrast)
  let source: ResolvedAppPalette["source"]
  let colors: ThemeColors

  if (hcOverride) {
    source = "high-contrast"
    colors = hcOverride
  } else {
    const resolved = resolveActiveThemeColors({
      colorTheme: input.colorTheme,
      resolvedTheme: variant,
      activeCustomThemeId: input.activeCustomThemeId,
      customThemes: input.customThemes,
      accentColor: input.accentColor,
    })
    if (input.pluginTheme) {
      // A plugin theme out-specifies the preset/custom cascade in the DOM (its
      // `<style>` block wins and `CustomThemeApplier` stands down), so it wins
      // here too. Merged over the resolved baseline rather than used alone: a
      // `cssVariables` theme may declare only a handful of tokens, and the rest
      // must still resolve to something coherent.
      source = "plugin"
      colors = { ...resolved.colors, ...pluginThemeColors(input.pluginTheme) }
    } else {
      source = resolved.themeSource
      colors = resolved.colors
    }
  }

  const cbOverrides = colorblindThemeOverrides(colorblind)
  if (Object.keys(cbOverrides).length > 0) {
    colors = { ...colors, ...cbOverrides } as ThemeColors
  }

  // Fill the advanced tokens last, so a derived one (the "running" workflow
  // badge tracking `warning`, the brand wash tracking `brandAction` and
  // `background`) is computed from the palette that actually won — including a
  // high-contrast replacement or a colorblind patch, not the theme underneath.
  const resolvedColors = normalizeThemeColors(colors, variant)

  return {
    colors: ensureForegroundContrast(resolvedColors),
    variant,
    source,
    highContrast: hcOverride != null,
    colorblind,
  }
}
