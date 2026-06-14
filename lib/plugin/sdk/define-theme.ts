/**
 * Plugin SDK helper for theme contributions (ADR-0026 / ADR-0030).
 *
 * Pure typesafety pass-through — wrapping a theme in `defineTheme()` gives
 * plugin authors autocomplete and a compile-time check that the shape matches
 * one of the `PluginThemeContribution` variants (inline colors, VSCode JSON
 * path, or scoped CSS variables).
 *
 * Usage:
 *   const noir = defineTheme({
 *     id: "noir",
 *     name: "Noir",
 *     isDark: true,
 *     colors: { background: "oklch(0.18 0 0)", foreground: "oklch(0.95 0 0)" },
 *   })
 */

import type { PluginThemeContribution } from "@/types/plugin"

export function defineTheme(theme: PluginThemeContribution): PluginThemeContribution {
  return theme
}
