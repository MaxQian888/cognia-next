/**
 * Plugin SDK helper for the `terminal-completion` capability.
 *
 * Pure typesafety pass-through for
 * `manifest.terminalCompletionProviders[]` entries.
 */

import type { PluginTerminalCompletionProviderDef } from "@/types/plugin/plugin-terminal-completion"

export function defineTerminalCompletionProvider(
  def: PluginTerminalCompletionProviderDef
): PluginTerminalCompletionProviderDef {
  return def
}
