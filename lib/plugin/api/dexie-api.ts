/**
 * Plugin Dexie API — namespace-enforcing wrapper around Dexie.
 *
 * Plugins receive this via `ctx.dexie`. Every `table()` call is intercepted to
 * prepend the plugin's own namespace prefix, so a plugin can never access
 * another plugin's tables or the core CogniaDB tables.
 */

import type Dexie from "dexie"
import { toNamespacedTableName, fromNamespacedTableName } from "@/lib/plugin/dexie/namespace"

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
   * Returns a namespace-enforcing view of the Dexie instance for advanced
   * queries and transactions. `table(...)` and `transaction(...)` validate
   * every table name against this plugin's `<pluginId>:` namespace — a bare
   * name is auto-prefixed, a name already prefixed to this plugin passes
   * through, and a name prefixed to a *different* plugin (or a core CogniaDB
   * table) is rejected. This closes the isolation hole where the raw instance
   * let a plugin reach `db.table("characters")` or another plugin's tables.
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
  // Resolve a caller-supplied table name to this plugin's namespace:
  //  - bare name        → `<pluginId>:<name>`
  //  - `<pluginId>:x`   → passes through (already correctly namespaced)
  //  - `<other>:x`      → rejected (cross-plugin / core-table access)
  const resolveTableName = (name: string): string => {
    const parsed = fromNamespacedTableName(name)
    if (parsed) {
      if (parsed.pluginId !== pluginId) {
        throw new Error(
          `Plugin "${pluginId}" attempted to access table "${name}" which is not in its namespace`
        )
      }
      return name
    }
    return toNamespacedTableName(pluginId, name)
  }

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
      // A Proxy over the real Dexie instance that re-routes `table` and
      // `transaction` through `resolveTableName`, so the raw escape hatch can
      // no longer reach tables outside this plugin's namespace. All other
      // members are forwarded (methods bound to the real instance so Dexie's
      // internal `this` stays correct).
      const handler: ProxyHandler<Dexie> = {
        get(target, prop, receiver) {
          if (prop === "table") {
            return <T, K = unknown>(name: string): Dexie.Table<T, K> =>
              target.table<T, K>(resolveTableName(name))
          }
          if (prop === "transaction") {
            return (...args: unknown[]): unknown => {
              // Dexie: transaction(mode, ...tables, scope). The first arg is
              // the mode, the last is the scope function; everything between
              // is a table spec (string | Dexie.Table | array of those).
              const resolved = args.map((arg, index) => {
                if (index === 0 || typeof arg === "function") return arg
                if (typeof arg === "string") return resolveTableName(arg)
                if (Array.isArray(arg)) {
                  return arg.map((t) => (typeof t === "string" ? resolveTableName(t) : t))
                }
                return arg
              })
              return (target.transaction as (...a: unknown[]) => unknown)(...resolved)
            }
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === "function" ? value.bind(target) : value
        },
      }
      return new Proxy(db, handler)
    },
  }
}
