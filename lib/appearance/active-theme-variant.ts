/**
 * Which palette the active theme contributes in the mode the app is in now.
 *
 * There is ONE active theme, not a light slot and a dark slot:
 * `activeCustomThemeId` and `activePluginThemeId` are mutually exclusive
 * pointers that name a single theme for both modes. The light / dark radio
 * then decides which of that theme's palettes is painted. So "Active" on a
 * Dracula card while the app is in light mode is true but incomplete: what the
 * user needs to know is what Dracula is doing in light mode right now, and the
 * answer is one of four things:
 *
 *  - `authored`: the theme ships its own palette for this mode and that
 *    palette is painted.
 *  - `derived`: the theme ships only the other mode's palette; the one painted
 *    here was derived from it (`deriveOppositeVariant`) when the theme was
 *    activated or imported. Every built-in VSCode preset and VSCode import
 *    lands here in its opposite mode.
 *  - `fixed`: a directly activated plugin theme is a single `:root{}` block
 *    (`PluginThemeApplier`) and is painted as-is in both modes. It does not
 *    adapt to the mode.
 *  - `dormant`: **intentionally dormant.** A single-palette custom theme with
 *    no `tokens` for this mode (a pre-dual-variant row, or a plugin's
 *    `ctx.theme.registerCustomTheme` call that sent only `colors`) contributes
 *    nothing in the other mode: `resolveActiveThemeColors` paints the color
 *    preset's base palette instead. The theme stays selected rather than being
 *    deselected, and applies again as soon as the mode flips back. Because the
 *    card still says "Active", the UI must label this state as inactive for
 *    the current mode (`ActiveThemeBadge`), and the mirror test in
 *    `active-theme-variant.test.ts` pins it against the resolver.
 *
 * Pure, and deliberately a mirror of the resolver's rule in
 * `lib/themes/index.ts` (`resolveActiveThemeColors`) rather than a second
 * opinion; the test cross-checks the two so they cannot drift.
 */

import type { CustomTheme } from "@/types/plugin/plugin"

export type ThemeMode = "light" | "dark"

/**
 * What the active theme contributes in the current mode (see the module doc).
 *
 * `dormant` is INTENTIONAL DORMANCY: the theme stays selected but paints
 * nothing in this mode (a single-palette theme outside its own mode), and the
 * base color preset shows instead. Labeled inert in the UI by
 * `ActiveThemeBadge` / `ActiveThemeAppliedNote` (muted, `data-dormant`,
 * "inactive in … mode"), and pinned against the palette resolver by
 * `active-theme-variant.test.ts` ("agrees with the palette resolver").
 */
export type ActiveThemeVariantKind = "authored" | "derived" | "fixed" | "dormant"

export interface ActiveThemeVariant {
  kind: ActiveThemeVariantKind
  /** The mode the app is painted in right now. */
  mode: ThemeMode
  /**
   * The theme's own (authored) variant: what its card's Light / Dark pill
   * says. `null` for a legacy row that records neither `baseVariant` nor
   * `isDark`, which is dormant in both modes.
   */
  themeVariant: ThemeMode | null
}

/**
 * The mode the appliers paint for a `next-themes` `resolvedTheme`: anything but
 * `"light"` reads as dark, exactly as `CustomThemeApplier` does. `null` while
 * next-themes is still hydrating, when no mode has been painted yet.
 */
export function themeModeFromResolved(resolvedTheme: string | undefined | null): ThemeMode | null {
  if (!resolvedTheme) return null
  return resolvedTheme === "light" ? "light" : "dark"
}

function opposite(mode: ThemeMode): ThemeMode {
  return mode === "light" ? "dark" : "light"
}

/** The variant a custom theme was authored in, by the same precedence the resolver uses. */
export function customThemeBaseVariant(theme: CustomTheme): ThemeMode | null {
  if (theme.baseVariant) return theme.baseVariant
  if (theme.isDark === true) return "dark"
  if (theme.isDark === false) return "light"
  if (theme.derivedVariant) return opposite(theme.derivedVariant)
  return null
}

/** What an active custom theme contributes in `mode`. */
export function customThemeVariantIn(theme: CustomTheme, mode: ThemeMode): ActiveThemeVariant {
  const themeVariant = customThemeBaseVariant(theme)
  // Same order as `resolveActiveThemeColors`: dual-variant tokens first, then
  // the legacy single `colors` set, which only counts in its own mode.
  if (theme.tokens?.[mode]) {
    return { kind: theme.derivedVariant === mode ? "derived" : "authored", mode, themeVariant }
  }
  const legacyApplies = theme.isDark === (mode === "dark") && theme.colors !== undefined
  return { kind: legacyApplies ? "authored" : "dormant", mode, themeVariant }
}

/** Minimal shape of a registered plugin theme this module reads. */
export interface PluginThemeVariantSource {
  variant?: ThemeMode
  isDark?: boolean
}

/** What a directly activated plugin theme contributes in `mode`. */
export function pluginThemeVariantIn(
  theme: PluginThemeVariantSource,
  mode: ThemeMode
): ActiveThemeVariant {
  const themeVariant: ThemeMode | null =
    theme.variant ?? (theme.isDark === true ? "dark" : theme.isDark === false ? "light" : null)
  return { kind: themeVariant === mode ? "authored" : "fixed", mode, themeVariant }
}

/** A registered plugin theme as far as the active-theme status needs it. */
export interface ActivePluginThemeSource extends PluginThemeVariantSource {
  id: string
  name: string
}

export interface ActiveThemeSummary {
  /** `null` while no mode is painted yet or no theme is active. */
  status: ActiveThemeVariant | null
  /** Display name of the active theme, `null` when none is active. */
  name: string | null
}

/**
 * Status of whatever theme the settings pointers name, with the appliers'
 * precedence: a directly activated plugin theme owns the cascade
 * (`CustomThemeApplier` stands down for it), otherwise the active custom
 * theme. A pointer that names a theme which no longer exists reports nothing,
 * which is also what the appliers paint for it.
 */
export function resolveActiveThemeSummary(input: {
  mode: ThemeMode | null
  activePluginThemeId: string | null
  pluginThemes: readonly ActivePluginThemeSource[]
  activeCustomThemeId: string | null
  customThemes: readonly CustomTheme[]
}): ActiveThemeSummary {
  if (input.activePluginThemeId) {
    const plugin = input.pluginThemes.find((theme) => theme.id === input.activePluginThemeId)
    if (!plugin) return { status: null, name: null }
    return {
      status: input.mode ? pluginThemeVariantIn(plugin, input.mode) : null,
      name: plugin.name,
    }
  }
  if (!input.activeCustomThemeId) return { status: null, name: null }
  const custom = input.customThemes.find((theme) => theme.id === input.activeCustomThemeId)
  if (!custom) return { status: null, name: null }
  return {
    status: input.mode ? customThemeVariantIn(custom, input.mode) : null,
    name: custom.name,
  }
}
