/**
 * Plugin SDK helper for the `deployment-filter` capability.
 *
 * Pure typesafety pass-through for `manifest.deploymentFilters[]` entries.
 */

import type { PluginDeploymentFilterDef } from "@cognia/plugin-contract/types/plugin/plugin-deployment-filter"

export function defineDeploymentFilter(def: PluginDeploymentFilterDef): PluginDeploymentFilterDef {
  return def
}
