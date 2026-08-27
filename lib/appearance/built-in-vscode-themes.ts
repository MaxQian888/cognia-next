// Pre-built VSCode-inspired theme presets. These are the same JSON
// fixtures the import-dialog tests run against, inlined and pushed
// through `vscodeThemeToCustomTheme` + OKLCH derivation at module
// load. The result: users can apply Dracula / One Dark Pro / Tokyo
// Night Dark / Night Owl / GitHub Light Default with one click, without ever
// opening the import dialog. The list also serves as a runtime
// regression for the parser pipeline — if parsing or derivation
// regresses, these presets stop applying cleanly.

import draculaJson from "./vscode-theme/__fixtures__/dracula.json"
import oneDarkProJson from "./vscode-theme/__fixtures__/one-dark-pro.json"
import tokyoNightJson from "./vscode-theme/__fixtures__/tokyo-night-dark.json"
import nightOwlJson from "./vscode-theme/__fixtures__/night-owl.json"
import githubLightJson from "./vscode-theme/__fixtures__/github-light-default.json"
import { vscodeThemeToCustomTheme, type VscodeThemeJson } from "./vscode-theme/parse-json"
import { deriveOppositeVariant } from "./derive-variant"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin"

/**
 * A pre-built CustomTheme produced from an inlined VSCode JSON. The parser
 * always populates the `colors` field at runtime; we derive the opposite
 * variant via OKLCH so users get correct light/dark behaviour without
 * needing to import or re-parse anything.
 */
export type BuiltInVscodeTheme = Omit<CustomTheme, "id">

function build(name: string, json: unknown): BuiltInVscodeTheme {
  const parsed = vscodeThemeToCustomTheme(json as VscodeThemeJson, { nameHint: name })
  const baseVariant: "light" | "dark" = parsed.theme.isDark ? "dark" : "light"
  const opposite: "light" | "dark" = baseVariant === "dark" ? "light" : "dark"
  const single = parsed.theme.colors as ThemeColors
  return {
    name,
    baseVariant,
    derivedVariant: opposite,
    tokens: {
      [baseVariant]: single,
      [opposite]: deriveOppositeVariant(single, baseVariant),
    } as { light: ThemeColors; dark: ThemeColors },
    // Keep legacy fields populated so the rollback contract from Task 8 holds
    // for one-click presets too.
    isDark: baseVariant === "dark",
    colors: single,
  }
}

/**
 * Curated VSCode-style presets. Each one runs through the same JSON parser
 * the import dialog uses, so this list also serves as a regression fixture
 * for the parser pipeline (Tasks 10 + 11).
 */
export const BUILT_IN_VSCODE_THEMES: ReadonlyArray<BuiltInVscodeTheme> = [
  build("Dracula", draculaJson),
  build("One Dark Pro", oneDarkProJson),
  build("Tokyo Night Dark", tokyoNightJson),
  build("Night Owl", nightOwlJson),
  build("GitHub Light Default", githubLightJson),
]
