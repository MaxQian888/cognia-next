/**
 * Plugin SDK helper for theme packs (ADR-0029 / ADR-0030).
 *
 * Pure typesafety pass-through — wrapping a pack in `defineThemePack()` gives
 * plugin authors autocomplete and a compile-time check that the shape matches
 * `PluginThemePackContribution`. A pack is an applyable bundle that references
 * sibling theme / font / wallpaper / density contributions by id.
 *
 * Usage:
 *   const comfort = defineThemePack({
 *     id: "aurora-comfort",
 *     name: "Aurora Comfort",
 *     applies: { themeId: "aurora", fontFamily: "Inter", density: "comfortable" },
 *   })
 */

import type { PluginThemePackContribution } from "@/types/plugin"

export function defineThemePack(pack: PluginThemePackContribution): PluginThemePackContribution {
  return pack
}
