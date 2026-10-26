/**
 * Plugin SDK helper for scheduled task contributions.
 *
 * Pure typesafety pass-through for `manifest.scheduledTasks[]` entries.
 */

import type { PluginScheduledTaskDef } from "@cognia/plugin-contract/types/plugin/plugin"

export function defineScheduledTask(def: PluginScheduledTaskDef): PluginScheduledTaskDef {
  return def
}
