/**
 * The ONE liveness rule: is this plugin's contributed code allowed to run
 * right now?
 *
 * Extracted from `hook-registry.ts` so the interceptor registry can consult the
 * same rule without importing the hook registry — which imports the interceptor
 * registry to normalize legacy hooks, and would close a module cycle. The rule
 * has to be shared rather than re-derived: two dispatchers each keeping their
 * own idea of "enabled" is the exact split the hook registry was created to
 * end, and a cycle-avoiding copy would quietly recreate it.
 */

import type { PluginSource, PluginStatus } from "../../../types/plugin"

/** The two facts liveness and dispatch trust read from a plugin's store row. */
export interface PluginRecordFacts {
  status: PluginStatus
  source?: PluginSource
}

/** Reads a plugin's current row, or `undefined` while it has none. */
export type PluginRecordReader = (pluginId: string) => PluginRecordFacts | undefined

let readPluginRecord: PluginRecordReader = () => undefined

/**
 * Host seam: the plugin store installs its reader when the store is created
 * (`stores/plugin-runtime/plugin-store.ts`). Until then there are no rows, and
 * the default reader answers exactly that, so every rule below gives the same
 * answer it gives a plugin with no row yet.
 */
export function installPluginRecordReader(reader: PluginRecordReader): void {
  readPluginRecord = reader
}

/** A plugin's current row facts, read live (never cached). */
export function readPluginRecordFacts(pluginId: string): PluginRecordFacts | undefined {
  return readPluginRecord(pluginId)
}

/**
 * A plugin's contributions run only while the plugin is enabled.
 *
 * Reads the store rather than caching, because enablement flips at runtime and
 * a cached copy is how the dispatchers drifted apart in the first place. A
 * plugin that has registered but has no store row yet is mid-activation and
 * counts as live, so its own `onEnable` can still fire.
 */
export function isPluginHooksEnabled(pluginId: string): boolean {
  const row = readPluginRecordFacts(pluginId)
  if (!row) return true
  return row.status === "enabled"
}
