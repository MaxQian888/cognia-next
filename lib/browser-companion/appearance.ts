/**
 * Serialize the Host's resolved appearance for the browser side panel.
 *
 * The extension ships no copy of the palette. It could have: 56 tokens is a
 * small file, and `app/globals.css` is right there. But a copy is a second
 * source of truth that only diverges — and worse, it would be *wrong for this
 * user*, because a Cognia palette is not a constant. Presets, hand-authored
 * custom themes, imported VSCode themes, plugin themes, high-contrast and
 * colorblind patches all resolve into it, and none of that is knowable at the
 * extension's build time.
 *
 * So the Host resolves and sends values. `resolveAppPalette` is the same
 * function `CustomThemeApplier` uses to paint the app, and
 * `THEME_TOKEN_CSS_VARS` is the same catalog that names the custom properties
 * it writes — which is what makes the panel and the app the same colour by
 * construction rather than by agreement.
 *
 * Shape only travels as four numbers rather than a stylesheet: the extension
 * has its own Tailwind build, so it needs the `--radius` base and the pill
 * radius, not the derived `rounded-*` utilities.
 */
import type { BrowserCompanionAppearanceV1 } from "@/types/browser-companion"
import type { AppPaletteInput } from "@/lib/appearance/resolve-app-palette"
import { resolveAppPalette } from "@/lib/appearance/resolve-app-palette"
import { THEME_TOKEN_CATALOG } from "@/lib/appearance/theme-token-catalog"
import type { DensityLevel } from "@/types/appearance"
import { DEFAULT_STYLE_PACK_ID, STYLE_PACKS, type StylePackId } from "@/types/appearance/style-pack"

export interface BrowserAppearanceInput extends AppPaletteInput {
  /** The active style pack; its tokens supply radius, pill shape and density. */
  stylePackId?: StylePackId
  /** Explicit density override, when the user set one outside the pack. */
  density?: DensityLevel
}

/**
 * Every custom property a theme owns, resolved to a concrete value.
 *
 * Built from the catalog rather than from `Object.entries(colors)` so the CSS
 * variable names are the catalog's — a camel→kebab guess turns `chart1` into
 * `--chart1` and `workflowTrigger` into `--workflow-trigger`, neither of which
 * any stylesheet reads.
 */
export function appearanceCssVars(input: AppPaletteInput): Record<string, string> {
  const { colors } = resolveAppPalette(input)
  const vars: Record<string, string> = {}
  for (const token of THEME_TOKEN_CATALOG) {
    const value = colors[token.key]
    if (typeof value === "string" && value.trim().length > 0) {
      vars[token.cssVar] = value.trim()
    }
  }
  return vars
}

export function buildBrowserCompanionAppearance(
  input: BrowserAppearanceInput
): BrowserCompanionAppearanceV1 {
  const pack = STYLE_PACKS[input.stylePackId ?? DEFAULT_STYLE_PACK_ID]
  return {
    mode: input.resolvedTheme === "light" ? "light" : "dark",
    cssVars: appearanceCssVars(input),
    radiusBaseRem: pack.radiusBaseRem,
    pillRadiusPx: pack.pillRadiusPx,
    density: input.density ?? pack.density,
  }
}
