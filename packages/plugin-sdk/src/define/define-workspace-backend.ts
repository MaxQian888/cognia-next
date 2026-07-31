/**
 * Plugin SDK helper for the `workspace-backend` capability.
 *
 * Pure typesafety pass-through for `manifest.workspaceBackends[]` entries.
 */

import type { PluginWorkspaceBackendDef } from "@/types/plugin/plugin-workspace-backend"

export function defineWorkspaceBackend(def: PluginWorkspaceBackendDef): PluginWorkspaceBackendDef {
  return def
}
