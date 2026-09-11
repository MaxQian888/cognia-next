/**
 * Plugin SDK helper for the `subagent` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineSubagent()` gives plugin authors autocomplete and a compile-time
 * check that the def shape matches `PluginSubagentDef`.
 *
 * Usage:
 *   const reviewer = defineSubagent({
 *     id: "code-reviewer",
 *     name: "Code Reviewer",
 *     description: "Reviews code changes against repo conventions.",
 *     prompt: "You are a code reviewer ...",
 *     tools: ["Read", "Grep"],
 *     model: "sonnet",
 *     effort: "high",
 *   })
 */

import type { PluginToolDef } from "@/types/plugin/plugin"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { normalizeCogniaModelBinding } from "@/types/agent/external-agent"

export type PluginSubagentToolReference = string | Pick<PluginToolDef, "name">

export type PluginSubagentInput = Omit<PluginSubagentDef, "tools"> & {
  /** Tool names or definitions returned by `defineTool()`. */
  tools?: ReadonlyArray<PluginSubagentToolReference>
}

export function defineSubagent(def: PluginSubagentInput): PluginSubagentDef {
  normalizeCogniaModelBinding(def.cogniaModel)
  if (!def.tools || def.tools.every((tool) => typeof tool === "string")) {
    return def as PluginSubagentDef
  }
  return {
    ...def,
    tools: def.tools.map((tool) => (typeof tool === "string" ? tool : tool.name)),
  }
}
