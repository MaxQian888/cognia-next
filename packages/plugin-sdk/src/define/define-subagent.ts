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

import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"

export function defineSubagent(def: PluginSubagentDef): PluginSubagentDef {
  return def
}
