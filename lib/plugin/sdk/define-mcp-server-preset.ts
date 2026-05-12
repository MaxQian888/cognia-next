/**
 * Plugin SDK helper for the `mcp-server-preset` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineMcpServerPreset()` gives plugin authors autocomplete and a
 * compile-time check that the def shape matches `PluginMcpServerPresetDef`.
 * No runtime work happens here; the plugin manager (M1·T5) reads the same
 * manifest field and registers it into the overlay during plugin enable.
 *
 * Usage (in a plugin's manifest builder or activate fn):
 *   const playwright = defineMcpServerPreset({
 *     id: "playwright",
 *     name: "Playwright",
 *     transport: "stdio",
 *     config: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
 *   })
 *
 * Part of the plugin-first Computer Use plan (M1·T6).
 */

import type { PluginMcpServerPresetDef } from "@/types/plugin/plugin-mcp-preset"

export function defineMcpServerPreset(def: PluginMcpServerPresetDef): PluginMcpServerPresetDef {
  return def
}
