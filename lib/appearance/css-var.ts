import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { THEME_COLOR_KEYS } from "./vscode-theme/token-mapping"

/**
 * Convert a ThemeColors key (camelCase) to its CSS custom-property name (kebab).
 * `primaryForeground` → `--primary-foreground`. The mapping is a direct
 * camel→kebab transform; the `app/globals.css` variable names match.
 */
export function themeKeyToCssVar(key: keyof ThemeColors | string): string {
  const kebab = key.replace(/([A-Z])/g, "-$1").toLowerCase()
  return `--${kebab}`
}

export const CSS_VAR_KEYS: readonly string[] = THEME_COLOR_KEYS.map(themeKeyToCssVar)
