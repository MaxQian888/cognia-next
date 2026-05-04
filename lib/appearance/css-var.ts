import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { THEME_COLOR_KEYS } from "./vscode-theme/token-mapping"

/**
 * Convert a ThemeColors key (camelCase) to its CSS custom-property name (kebab).
 * `primaryForeground` → `--primary-foreground`. The mapping is a direct
 * camel→kebab transform; the `app/globals.css` variable names match.
 */
export function themeKeyToCssVar(key: keyof ThemeColors | string): string {
  // Use a positive lookbehind via the captured lowercase char so we never
  // match at position 0 — `Primary` would otherwise become `---primary`.
  const kebab = key.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()
  return `--${kebab}`
}

export const CSS_VAR_KEYS: readonly string[] = THEME_COLOR_KEYS.map(themeKeyToCssVar)
