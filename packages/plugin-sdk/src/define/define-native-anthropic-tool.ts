/**
 * Plugin SDK helper for the `native-anthropic-tool` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineNativeAnthropicTool()` gives plugin authors autocomplete and a
 * compile-time check that the def shape matches
 * `PluginNativeAnthropicToolDef`. Useful when constructing Anthropic
 * native tool defs (computer_20251124 / bash_20250124 /
 * text_editor_20250728) since the per-type optional fields
 * (`displayWidthPx`, `enableZoom`, etc.) are easy to mistype.
 *
 * Usage:
 *   const computerTool = defineNativeAnthropicTool({
 *     id: "computer",
 *     name: "computer",
 *     type: "computer_20251124",
 *     displayWidthPx: 1280,
 *     displayHeightPx: 800,
 *     enableZoom: true,
 *     executeIpc: { invoke: "plugin_computer_use_execute" },
 *   })
 *
 * Part of the plugin-first Computer Use plan (M1·T6).
 */

import type { PluginNativeAnthropicToolDef } from "@/types/plugin/plugin-native-tool"

export function defineNativeAnthropicTool(
  def: PluginNativeAnthropicToolDef
): PluginNativeAnthropicToolDef {
  return def
}
