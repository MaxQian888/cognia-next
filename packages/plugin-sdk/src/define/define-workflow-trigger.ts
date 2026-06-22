/**
 * Plugin SDK helper for custom visual-workflow trigger sources (ADR-0017).
 *
 * Pure typesafety pass-through — wrapping a trigger in `defineWorkflowTrigger()`
 * gives plugin authors autocomplete and a compile-time check that the shape
 * matches `PluginTriggerDef` (the full runtime definition, including the
 * `start` function that begins emitting `TriggerEvent`s and returns a handle
 * whose `stop()` winds the source down). The runtime prefixes `kind` with the
 * plugin id at registration time.
 *
 * Usage:
 *   const poll = defineWorkflowTrigger({
 *     kind: "trigger.poll",
 *     typeVersion: 1,
 *     label: "Poll",
 *     description: "Emit on an interval.",
 *     iconName: "timer",
 *     paramsSchema: { type: "object", properties: { everyMs: { type: "number" } } },
 *     start: async (ctx) => ({ stop: () => {} }),
 *   })
 */

import type { PluginTriggerDef } from "@/types/plugin/plugin-workflow"

export function defineWorkflowTrigger(trigger: PluginTriggerDef): PluginTriggerDef {
  return trigger
}
