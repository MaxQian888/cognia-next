/**
 * Plugin SDK helper for the `shared-memory-adapter` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineSharedMemoryAdapter()` checks the shape (id/name + the write/read/
 * listChanges/delete mirror methods) against `PluginSharedMemoryAdapterDef`.
 */

import type { PluginSharedMemoryAdapterDef } from "@/types/plugin/plugin-shared-memory-adapter"

export function defineSharedMemoryAdapter(
  def: PluginSharedMemoryAdapterDef
): PluginSharedMemoryAdapterDef {
  return def
}
