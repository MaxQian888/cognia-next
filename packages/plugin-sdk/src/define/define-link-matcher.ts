/** Pure authoring helper for lazy inline `manifest.linkMatchers[]` contributions. */
import type { PluginLinkMatcherDef } from "@cognia/plugin-contract/types/plugin/plugin-link-matcher"

export function defineLinkMatcher(def: PluginLinkMatcherDef): PluginLinkMatcherDef {
  return def
}
