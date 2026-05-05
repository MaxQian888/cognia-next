/**
 * Plugin connectors bridge — Task 110.
 *
 * Discovers plugin manifests that declare `connectors` entries, invokes each
 * entry's `factory` function to build a `PlatformAdapter`, and registers the
 * result with the `ConnectorBus` singleton.
 *
 * Lifecycle:
 *   - `registerPluginAdapters(pluginId, manifest, exports)` — call on plugin enable.
 *   - `unregisterPluginAdapters(pluginId)` — call on plugin disable/uninstall.
 *
 * The bridge is intentionally thin. It only discovers and wires; it does not
 * own the bus or impose any constraint on the adapter shape beyond what
 * `PlatformAdapter` requires. Policy, FIFO queuing, retries, etc. all flow
 * through the existing bus/runner machinery unchanged.
 *
 * NOTE: Plugin connector adapters run in the renderer (TypeScript), same as
 * built-in adapters. Rust transport primitives (axum, keyring) are accessed
 * via the same Tauri command shims in `lib/connectors/tauri/commands.ts`.
 */

import type { PluginManifest, PluginConnectorDef } from "@/types/plugin/plugin"
import type { PlatformAdapter } from "@/types/connectors"
import { getBus } from "@/lib/connectors/bus"

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The context object passed to each adapter factory function.
 * Mirrors `AdapterContext` from the adapter plan without importing it
 * (the full type lives in types/connectors/adapter.ts; we use a structural
 * subset here so the bridge stays decoupled from internal adapter details).
 */
export interface PluginAdapterContext {
  pluginId: string
  connectorDef: PluginConnectorDef
}

/** A plugin's exported module — keys are function names. */
export type PluginExports = Record<string, unknown>

/** Factory function signature a plugin must export for each connector. */
export type AdapterFactory = (
  ctx: PluginAdapterContext
) => PlatformAdapter | Promise<PlatformAdapter>

// ── Registry ─────────────────────────────────────────────────────────────────

/** pluginId → list of adapter ids registered by that plugin */
const pluginAdapterIds = new Map<string, string[]>()

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build and register all connector adapters declared by `manifest.connectors`.
 *
 * @param pluginId  Unique plugin identifier (from `manifest.id`).
 * @param manifest  The validated plugin manifest.
 * @param exports   The plugin module's exports (used to look up `factory` names).
 */
export async function registerPluginAdapters(
  pluginId: string,
  manifest: PluginManifest,
  exports: PluginExports
): Promise<void> {
  const defs = manifest.connectors
  if (!defs || defs.length === 0) return

  const bus = getBus()
  const ids: string[] = []

  for (const def of defs) {
    const factoryFn = exports[def.factory]
    if (typeof factoryFn !== "function") {
      console.warn(
        `[connectors-bridge] plugin ${pluginId}: factory "${def.factory}" not found in exports — skipping`
      )
      continue
    }

    let adapter: PlatformAdapter
    try {
      adapter = await (factoryFn as AdapterFactory)({ pluginId, connectorDef: def })
    } catch (err) {
      console.error(`[connectors-bridge] plugin ${pluginId}: factory "${def.factory}" threw —`, err)
      continue
    }

    bus.registerAdapter(adapter)
    ids.push(adapter.id)
  }

  if (ids.length > 0) {
    pluginAdapterIds.set(pluginId, ids)
  }
}

/**
 * Unregister all connector adapters that were registered by `pluginId`.
 * Call on plugin disable or uninstall.
 */
export function unregisterPluginAdapters(pluginId: string): void {
  const ids = pluginAdapterIds.get(pluginId)
  if (!ids) return
  const bus = getBus()
  for (const id of ids) {
    bus.unregisterAdapter(id)
  }
  pluginAdapterIds.delete(pluginId)
}

/**
 * Return the list of adapter ids currently owned by a plugin.
 * Primarily for tests and diagnostics.
 */
export function getPluginAdapterIds(pluginId: string): readonly string[] {
  return pluginAdapterIds.get(pluginId) ?? []
}

/** Test-only: reset the internal registry. */
export function __resetBridgeForTesting(): void {
  pluginAdapterIds.clear()
}
