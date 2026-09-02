/**
 * Plugin SDK helper for the `provider-operation-adapter` capability (ADR-0163).
 *
 * Pure typesafety pass-through. Wrapping a manifest entry in
 * `defineProviderOperationAdapter()` checks the shape (a contract operation
 * id, a provider match and an async handler, plus a registry `id`) against
 * `PluginProviderOperationAdapterDef`. The host binds the handler into the
 * operation registry on enable with `support: "plugin"`.
 */

import type { PluginProviderOperationAdapterDef } from "@/types/plugin/plugin-provider-operation-adapter"

export function defineProviderOperationAdapter(
  def: PluginProviderOperationAdapterDef
): PluginProviderOperationAdapterDef {
  return def
}
