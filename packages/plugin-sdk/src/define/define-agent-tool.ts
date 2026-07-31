/**
 * Plugin SDK helper for an inline Agent SDK tool.
 *
 * Pure typesafety pass-through — wrapping a tool in `defineAgentTool()` gives
 * plugin authors autocomplete and a compile-time check against
 * `PluginAgentToolInput` (the shape accepted by `ctx.agent.run({ tools })`).
 *
 * Usage:
 *   const fetchTool = defineAgentTool({
 *     name: "web_fetch",
 *     description: "Fetch a URL and return the body.",
 *     parameters: { type: "object", properties: { url: { type: "string" } } },
 *     execute: async ({ url }) => fetch(String(url)).then((r) => r.text()),
 *     canUseTool: createPiiRedactionGate(),
 *   })
 */

import type { PluginAgentToolInput } from "@/types/plugin/plugin-agent-sdk"

export function defineAgentTool(tool: PluginAgentToolInput): PluginAgentToolInput {
  return tool
}
