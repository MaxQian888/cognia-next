/**
 * Plugin SDK helper for tools registered through `ctx.agent.registerTool()`.
 *
 * Unlike `defineTool()`, which defines a declarative `manifest.tools[]` row,
 * this helper includes the executor and deliberately does not require a
 * caller-supplied `pluginId`; the activated context owns that identity.
 */

import type { PluginToolRegistration } from "@/types/plugin/plugin"

export function definePluginTool(tool: PluginToolRegistration): PluginToolRegistration {
  return tool
}
