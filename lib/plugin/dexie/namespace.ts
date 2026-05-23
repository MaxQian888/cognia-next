/**
 * Pure helpers for plugin-declared Dexie table namespacing.
 *
 * Tables are stored in the shared CogniaDB instance as
 * `<pluginId>:<tableName>` so two plugins can declare the same logical
 * name without collision. These helpers are the single source of truth
 * for the prefix scheme; everywhere else in the dexie-bridge / dexie-api
 * pipeline must go through them.
 */

export const PLUGIN_TABLE_NAMESPACE_SEPARATOR = ":" as const

/** Cap per-plugin table count to keep the IndexedDB schema bounded. */
export const MAX_TABLES_PER_PLUGIN = 20

const NAME_REGEX = /^[a-z][a-zA-Z0-9_]{0,30}$/

export function isValidPluginTableName(name: string): boolean {
  return typeof name === "string" && NAME_REGEX.test(name)
}

export function toNamespacedTableName(pluginId: string, tableName: string): string {
  return `${pluginId}${PLUGIN_TABLE_NAMESPACE_SEPARATOR}${tableName}`
}

/**
 * Reverse of {@link toNamespacedTableName}. Returns null for table names
 * that don't carry the namespace prefix (i.e. core CogniaDB tables).
 */
export function fromNamespacedTableName(
  namespaced: string
): { pluginId: string; tableName: string } | null {
  const sep = namespaced.indexOf(PLUGIN_TABLE_NAMESPACE_SEPARATOR)
  if (sep <= 0 || sep === namespaced.length - 1) return null
  return {
    pluginId: namespaced.slice(0, sep),
    tableName: namespaced.slice(sep + 1),
  }
}
