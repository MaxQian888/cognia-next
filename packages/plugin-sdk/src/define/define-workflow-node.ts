/**
 * Plugin SDK helper for custom visual-workflow node executors (ADR-0017).
 *
 * Pure typesafety pass-through — wrapping a node in `defineWorkflowNode()`
 * gives plugin authors autocomplete and a compile-time check that the shape
 * matches `PluginNodeDef` (the full runtime definition, including the
 * `execute` function the orchestrator invokes). The runtime prefixes `kind`
 * with the plugin id at registration time.
 *
 * Usage:
 *   const fetchPage = defineWorkflowNode({
 *     kind: "action.fetchPage",
 *     typeVersion: 1,
 *     category: "plugin",
 *     label: "Fetch Page",
 *     description: "Fetch a URL and return its text.",
 *     iconName: "globe",
 *     paramsSchema: { type: "object", properties: { url: { type: "string" } } },
 *     execute: async (ctx) => ({ status: "success", output: {} }),
 *   })
 */

import type { PluginNodeDef } from "@/types/plugin/plugin-workflow"

export function defineWorkflowNode(node: PluginNodeDef): PluginNodeDef {
  return node
}
