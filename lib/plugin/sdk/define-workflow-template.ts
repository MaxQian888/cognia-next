/**
 * Plugin SDK helper for the `workflow-template` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineWorkflowTemplate()` gives plugin authors autocomplete and a
 * compile-time check that the def shape matches `PluginWorkflowTemplateDef`,
 * including the `requires` block (skill / mcp-preset / native-tool / subagent
 * ids + plugin node/trigger kinds).
 *
 * Usage:
 *   const tpl = defineWorkflowTemplate({
 *     id: "fetch-and-summarize",
 *     name: "Fetch & summarize",
 *     description: "HTTP GET → AI summary → Slack",
 *     category: "automation",
 *     nodes: [...],
 *     edges: [...],
 *     requires: { skillIds: ["my-plugin:summarize"] },
 *   })
 */

import type { PluginWorkflowTemplateDef } from "@/types/plugin/plugin-workflow-template"

export function defineWorkflowTemplate(def: PluginWorkflowTemplateDef): PluginWorkflowTemplateDef {
  return def
}
