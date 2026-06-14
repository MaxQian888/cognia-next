/**
 * Plugin SDK helper for bundled font families (ADR-0029).
 *
 * Pure typesafety pass-through — wrapping a font in `defineFontContribution()`
 * gives plugin authors autocomplete and a compile-time check that the shape
 * matches `PluginFontContribution` (a CSS family name + per-weight/style faces
 * resolved under the plugin install root by the font bridge).
 *
 * Usage:
 *   const inter = defineFontContribution({
 *     family: "Inter",
 *     files: [{ weight: 400, src: "assets/Inter-Regular.woff2" }],
 *     display: "swap",
 *   })
 */

import type { PluginFontContribution } from "@/types/plugin"

export function defineFontContribution(font: PluginFontContribution): PluginFontContribution {
  return font
}
