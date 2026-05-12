/**
 * Plugin Dexie API — namespace-enforcing wrapper around Dexie.
 *
 * Plugins receive this via `ctx.dexie`. Every `table()` call is intercepted to
 * prepend the plugin's own namespace prefix, so a plugin can never access
 * another plugin's tables or the core CogniaDB tables.
 */

import type Dexie from "dexie"
import { toNamespacedTableName, fromNamespacedTableName } from "@/lib/plugin/dexie-namespace"

export interface PluginDexieAPI {
  /**
   * Returns a Dexie Table scoped to this plugin.
   *
   * `name` is the logical table name as declared in manifest.dexie.tables —
   * no namespace prefix. Throws if the name is not in the plugin's registered
   * set (i.e. not declared in the manifest).
   */
  table<T, K = unknown>(name: string): Dexie.Table<T, K>

  /**
   * Returns the raw Dexie instance. Use for advanced queries, transactions,
   * etc. Callers are responsible for only touching tables that belong to this
   * plugin (prefixed with `<pluginId>:`).
   */
  rawDb(): Dexie
}

/**
 * Factory used by createPluginContext to build the ctx.dexie object.
 *
 * @param db      - The shared CogniaDB (or any Dexie) instance.
 * @param pluginId - The plugin's id. Used to build and validate namespace prefixes.
 */
export function createDexieAPI(db: Dexie, pluginId: string): PluginDexieAPI {
  return {
    table<T, K = unknown>(name: string): Dexie.Table<T, K> {
      const namespacedName = toNamespacedTableName(pluginId, name)

      // Verify the requested table actually belongs to this plugin.
      // fromNamespacedTableName returns null for non-prefixed names, and the
      // pluginId check guards against a plugin somehow injecting another
      // plugin's prefix into `name` (e.g. "other-plugin:repos").
      const parsed = fromNamespacedTableName(namespacedName)
      if (!parsed || parsed.pluginId !== pluginId) {
        throw new Error(
          `Plugin "${pluginId}" attempted to access table "${name}" which is not in its namespace`
        )
      }

      return db.table<T, K>(namespacedName)
    },

    rawDb(): Dexie {
      return db
    },
  }
}
