// CVD-safe palette overrides applied after the base theme colors are resolved.
// We deliberately *replace* the categorical tokens (`chart1..5`, the workflow
// node tokens, plus a few signal colors) instead of mutating presets so that
// switching back to "off" is a single token swap and so plugin themes keep
// their original palette when the user has CVD mode off.
//
// These used to be two views — a `ThemeColors` patch for the signal colors and
// a separate CSS-variable map for the categorical ones, written and cleared on
// its own code path in `CustomThemeApplier`. Now that charts and workflow nodes
// are real `ThemeColors` tokens there is one view: a single `Partial<ThemeColors>`
// that layers inside `resolveAppPalette` like every other override. That also
// removed a real ordering bug — the applier wrote the structured tokens first
// and cleared the previous frame's categorical vars afterwards, so turning CVD
// mode off would wipe the `--chart-*` values it had just written.
//
// Sources for the palettes:
//   - Deuteranopia / Protanopia: Wong, B. (2011) "Color blindness." Nature
//     Methods 8, 441. CIE-Lab-validated 7-color palette, widely used by
//     plotting libraries. Adapted to oklch for cognia-next.
//   - Tritanopia: Krzywinski/Birol (2024) "Visualizing biological data" —
//     8-color tritan-safe palette. Re-encoded in oklch.

import type { ThemeColors } from "@/types/plugin/plugin"
import type { ColorblindMode } from "@/types/appearance"

/**
 * The categorical tokens every CVD palette re-colours. `workflowAnnotation` and
 * the `workflowStatus*` set are deliberately absent: annotation is a neutral
 * grey that carries no categorical meaning, and the statuses either alias a
 * signal colour that is already patched (`running`/`succeeded`/`failed`) or are
 * greys of their own.
 */
export const COLORBLIND_CATEGORICAL_KEYS = [
  "chart1",
  "chart2",
  "chart3",
  "chart4",
  "chart5",
  "workflowTrigger",
  "workflowAction",
  "workflowAi",
  "workflowFlow",
  "workflowData",
  "workflowIo",
] as const satisfies readonly (keyof ThemeColors)[]

type ColorblindPaletteEntry = Partial<ThemeColors> &
  Record<(typeof COLORBLIND_CATEGORICAL_KEYS)[number], string>

const DEUTERANOPIA_SAFE: ColorblindPaletteEntry = {
  // Wong 7-color palette, oklch-encoded (lightness 0.55–0.78 to keep both
  // light- and dark-mode legibility).
  chart1: "oklch(0.6 0.18 220)", // blue
  chart2: "oklch(0.7 0.18 65)", // orange (replaces red — deut. confuses)
  chart3: "oklch(0.7 0.13 200)", // cyan
  chart4: "oklch(0.7 0.18 130)", // bluish-green
  chart5: "oklch(0.68 0.18 50)", // amber
  workflowTrigger: "oklch(0.7 0.18 130)",
  workflowAction: "oklch(0.6 0.18 220)",
  workflowAi: "oklch(0.55 0.2 290)",
  workflowFlow: "oklch(0.7 0.18 65)",
  workflowData: "oklch(0.68 0.18 50)",
  workflowIo: "oklch(0.7 0.13 200)",
  // Deuteranopes confuse red and green — push the destructive hue toward
  // a pure orange so it stays distinct from the success/wf-trigger hue.
  destructive: "oklch(0.62 0.22 35)",
}

const PROTANOPIA_SAFE: ColorblindPaletteEntry = {
  chart1: "oklch(0.58 0.18 230)",
  chart2: "oklch(0.72 0.18 75)",
  chart3: "oklch(0.68 0.13 195)",
  chart4: "oklch(0.66 0.16 140)",
  chart5: "oklch(0.7 0.18 55)",
  workflowTrigger: "oklch(0.66 0.16 140)",
  workflowAction: "oklch(0.58 0.18 230)",
  workflowAi: "oklch(0.55 0.2 290)",
  workflowFlow: "oklch(0.72 0.18 75)",
  workflowData: "oklch(0.7 0.18 55)",
  workflowIo: "oklch(0.68 0.13 195)",
  destructive: "oklch(0.64 0.22 40)",
}

const TRITANOPIA_SAFE: ColorblindPaletteEntry = {
  // Tritans confuse blue and green — shift the blues toward purple and the
  // greens toward yellow so the categorical separations survive.
  chart1: "oklch(0.55 0.2 290)",
  chart2: "oklch(0.66 0.19 25)",
  chart3: "oklch(0.6 0.13 250)",
  chart4: "oklch(0.74 0.18 100)",
  chart5: "oklch(0.68 0.18 55)",
  workflowTrigger: "oklch(0.74 0.18 100)",
  workflowAction: "oklch(0.55 0.2 290)",
  workflowAi: "oklch(0.6 0.13 250)",
  workflowFlow: "oklch(0.66 0.19 25)",
  workflowData: "oklch(0.68 0.18 55)",
  workflowIo: "oklch(0.55 0.13 200)",
  destructive: "oklch(0.62 0.22 18)",
}

const PALETTES: Record<Exclude<ColorblindMode, "off">, ColorblindPaletteEntry> = {
  deuter: DEUTERANOPIA_SAFE,
  protan: PROTANOPIA_SAFE,
  tritan: TRITANOPIA_SAFE,
}

/**
 * The `ThemeColors` field overrides for a given mode — signal *and* categorical
 * tokens in one patch. `off` yields an empty object so callers can spread it
 * unconditionally. Layered inside `resolveAppPalette` before anything writes,
 * so the overrides shadow the underlying preset / custom / plugin theme.
 */
export function colorblindThemeOverrides(mode: ColorblindMode): Partial<ThemeColors> {
  if (mode === "off") return {}
  return { ...PALETTES[mode] }
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
