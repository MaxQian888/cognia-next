// CVD-safe palette overrides applied after the base theme colors are resolved.
// We deliberately *replace* the categorical tokens (`chart-1..5`, workflow
// `--wf-*` tokens, plus a few signal colors) instead of mutating presets so
// that switching back to "off" is a single token swap and so plugin themes
// keep their original palette when the user has CVD mode off.
//
// Sources for the palettes:
//   - Deuteranopia / Protanopia: Wong, B. (2011) "Color blindness." Nature
//     Methods 8, 441. CIE-Lab-validated 7-color palette, widely used by
//     plotting libraries. Adapted to oklch for cognia-next.
//   - Tritanopia: Krzywinski/Birol (2024) "Visualizing biological data" —
//     8-color tritan-safe palette. Re-encoded in oklch.
//
// Each entry is a partial override map keyed by `ThemeColors` field name OR
// CSS custom property. We expose two views: `paletteAsThemeColors` (for the
// CustomThemeApplier to merge before `themeKeyToCssVar` writes) and
// `paletteAsCssVars` (for the chart / workflow tokens that don't live in
// `ThemeColors`).

import type { ThemeColors } from "@/types/plugin/plugin-extended"
import type { ColorblindMode } from "@/types/appearance"

/** CSS custom-property names this module knows about, beyond ThemeColors. */
export const COLORBLIND_EXTRA_VAR_KEYS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--wf-trigger",
  "--wf-action",
  "--wf-ai",
  "--wf-flow",
  "--wf-data",
  "--wf-io",
] as const

type ColorblindPaletteEntry = {
  /** Categorical (chart / wf) tokens — keyed by CSS variable name. */
  vars: Record<(typeof COLORBLIND_EXTRA_VAR_KEYS)[number], string>
  /** Optional ThemeColors overrides for signal tokens (destructive / warning). */
  themeOverrides?: Partial<ThemeColors>
}

const DEUTERANOPIA_SAFE: ColorblindPaletteEntry = {
  vars: {
    // Wong 7-color palette, oklch-encoded (lightness 0.55–0.78 to keep both
    // light- and dark-mode legibility).
    "--chart-1": "oklch(0.6 0.18 220)", // blue
    "--chart-2": "oklch(0.7 0.18 65)", // orange (replaces red — deut. confuses)
    "--chart-3": "oklch(0.7 0.13 200)", // cyan
    "--chart-4": "oklch(0.7 0.18 130)", // bluish-green
    "--chart-5": "oklch(0.68 0.18 50)", // amber
    "--wf-trigger": "oklch(0.7 0.18 130)",
    "--wf-action": "oklch(0.6 0.18 220)",
    "--wf-ai": "oklch(0.55 0.2 290)",
    "--wf-flow": "oklch(0.7 0.18 65)",
    "--wf-data": "oklch(0.68 0.18 50)",
    "--wf-io": "oklch(0.7 0.13 200)",
  },
  themeOverrides: {
    // Deuteranopes confuse red and green — push the destructive hue toward
    // a pure orange so it stays distinct from the success/wf-trigger hue.
    destructive: "oklch(0.62 0.22 35)",
  },
}

const PROTANOPIA_SAFE: ColorblindPaletteEntry = {
  vars: {
    "--chart-1": "oklch(0.58 0.18 230)",
    "--chart-2": "oklch(0.72 0.18 75)",
    "--chart-3": "oklch(0.68 0.13 195)",
    "--chart-4": "oklch(0.66 0.16 140)",
    "--chart-5": "oklch(0.7 0.18 55)",
    "--wf-trigger": "oklch(0.66 0.16 140)",
    "--wf-action": "oklch(0.58 0.18 230)",
    "--wf-ai": "oklch(0.55 0.2 290)",
    "--wf-flow": "oklch(0.72 0.18 75)",
    "--wf-data": "oklch(0.7 0.18 55)",
    "--wf-io": "oklch(0.68 0.13 195)",
  },
  themeOverrides: {
    destructive: "oklch(0.64 0.22 40)",
  },
}

const TRITANOPIA_SAFE: ColorblindPaletteEntry = {
  vars: {
    // Tritans confuse blue and green — shift the blues toward purple and the
    // greens toward yellow so the categorical separations survive.
    "--chart-1": "oklch(0.55 0.2 290)",
    "--chart-2": "oklch(0.66 0.19 25)",
    "--chart-3": "oklch(0.6 0.13 250)",
    "--chart-4": "oklch(0.74 0.18 100)",
    "--chart-5": "oklch(0.68 0.18 55)",
    "--wf-trigger": "oklch(0.74 0.18 100)",
    "--wf-action": "oklch(0.55 0.2 290)",
    "--wf-ai": "oklch(0.6 0.13 250)",
    "--wf-flow": "oklch(0.66 0.19 25)",
    "--wf-data": "oklch(0.68 0.18 55)",
    "--wf-io": "oklch(0.55 0.13 200)",
  },
  themeOverrides: {
    destructive: "oklch(0.62 0.22 18)",
  },
}

const PALETTES: Record<Exclude<ColorblindMode, "off">, ColorblindPaletteEntry> = {
  deuter: DEUTERANOPIA_SAFE,
  protan: PROTANOPIA_SAFE,
  tritan: TRITANOPIA_SAFE,
}

/**
 * Returns the CSS variable overrides for a given colorblind mode. `off`
 * yields an empty map so callers can unconditionally spread the result.
 */
export function colorblindCssVars(mode: ColorblindMode): Record<string, string> {
  if (mode === "off") return {}
  return { ...PALETTES[mode].vars }
}

/**
 * Returns the `ThemeColors` field overrides for a given mode. Callers
 * merge these into the resolved palette *before* `themeKeyToCssVar` writes,
 * so the overrides correctly shadow the underlying preset / custom theme.
 */
export function colorblindThemeOverrides(mode: ColorblindMode): Partial<ThemeColors> {
  if (mode === "off") return {}
  return { ...(PALETTES[mode].themeOverrides ?? {}) }
}

/**
 * Display-only metadata for the simulator strip in the a11y tab. The
 * matrices are the standard CVD simulation matrices from Brettel/Vienot/Mollon
 * (1997) — applied via SVG `<feColorMatrix>` so the UI can show "what the
 * page looks like" without committing a global theme change.
 *
 * Returned as the 20-value row-major matrix the SVG primitive expects.
 */
export const COLORBLIND_SIMULATOR_MATRICES: Record<Exclude<ColorblindMode, "off">, number[]> = {
  deuter: [
    0.367, 0.861, -0.228, 0, 0, 0.28, 0.673, 0.047, 0, 0, -0.012, 0.043, 0.969, 0, 0, 0, 0, 0, 1, 0,
  ],
  protan: [
    0.152, 1.053, -0.205, 0, 0, 0.115, 0.786, 0.099, 0, 0, -0.004, -0.048, 1.052, 0, 0, 0, 0, 0, 1,
    0,
  ],
  tritan: [
    1.255, -0.077, -0.178, 0, 0, -0.078, 0.931, 0.148, 0, 0, 0.005, 0.692, 0.302, 0, 0, 0, 0, 0, 1,
    0,
  ],
}
