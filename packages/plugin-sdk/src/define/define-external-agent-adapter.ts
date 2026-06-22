/**
 * Plugin SDK helper for the `external-agent-adapter` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineExternalAgentAdapter()` narrows the shape to
 * `PluginExternalAgentAdapterDef` (id + label + lazy `entry`/`export` factory
 * path) at authoring time.
 */

import type { PluginExternalAgentAdapterDef } from "@/types/plugin"

export function defineExternalAgentAdapter(
  def: PluginExternalAgentAdapterDef
): PluginExternalAgentAdapterDef {
  return def
}
