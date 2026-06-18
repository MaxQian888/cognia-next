/**
 * dexie-bridge — dynamic schema management for plugin-declared Dexie tables.
 *
 * Plugins declare tables in their manifest.dexie block. This module translates
 * those declarations into live Dexie schema bumps against the shared CogniaDB
 * instance at plugin enable/disable time.
 *
 * Key design decisions:
 *  - Table names are namespaced as `<pluginId>:<tableName>` to prevent
 *    collisions across plugins and with core CogniaDB tables.
 *  - On apply: db is closed → version(N+1).stores(patch) → db.open().
 *  - On remove: tables are nulled out (Dexie's mechanism for dropping a store)
 *    in the same close→bump→reopen cycle.
 *  - pluginDexieMeta is the source of truth for which tables are registered.
 */

import type Dexie from "dexie"
import type { PluginManifestDexieBlock } from "@/types/plugin"
import { createMutex } from "@/lib/utils/async-mutex"
import { toNamespacedTableName, MAX_TABLES_PER_PLUGIN } from "./namespace"
import { getPluginDexieMeta, putPluginDexiaMeta, deletePluginDexiaMeta } from "./meta"

export type RetentionMode = "keep" | "purge"

/**
 * A single process-wide lock serializing every schema mutation. The schema
 * bump is a read-modify-write on the shared Dexie instance (`verno + 1 →
 * close → version().stores() → open()`); two plugins enabling concurrently
 * would otherwise read the same `verno`, race close/open, and silently clobber
 * one schema patch. The lock keeps loads + activate() parallel while making
 * only this critical section mutually exclusive. Reuses `createMutex`.
 */
const schemaMutex = createMutex()

/**
 * Apply a plugin's declared Dexie tables to the shared CogniaDB instance.
 *
 * Safe to call multiple times for the same plugin (idempotent when the table
 * set hasn't changed). Throws if the plugin has already registered tables and
 * the table list has changed — the caller should call removePluginTables first
 * and then re-apply.
 */
export async function applyPluginTables(
  db: Dexie,
  pluginId: string,
  dexieBlock: PluginManifestDexieBlock
): Promise<void> {
  if (dexieBlock.tables.length > MAX_TABLES_PER_PLUGIN) {
    throw new Error(
      `Plugin "${pluginId}" declares ${dexieBlock.tables.length} tables, exceeding the maximum of ${MAX_TABLES_PER_PLUGIN}`
    )
  }

  // Whole body under the lock so the meta read → schema bump → meta write is
  // atomic against any other concurrent apply/remove (check-then-act safety).
  await schemaMutex.runExclusive(async () => {
    const existing = await getPluginDexieMeta(pluginId)
    const namespacedNames = dexieBlock.tables.map((t) => toNamespacedTableName(pluginId, t.name))

    if (existing) {
      const existingSet = new Set(existing.tableNames)
      const newSet = new Set(namespacedNames)
      const setsEqual =
        existingSet.size === newSet.size && [...existingSet].every((n) => newSet.has(n))
      if (setsEqual) return // already applied, nothing to do
    }

    const patch: Record<string, string> = {}
    for (const t of dexieBlock.tables) {
      const nsName = toNamespacedTableName(pluginId, t.name)
      patch[nsName] = t.schema
    }

    const nextVersion = db.verno + 1
    await db.close()
    db.version(nextVersion).stores(patch)
    await db.open()

    await putPluginDexiaMeta({
      pluginId,
      tableNames: namespacedNames,
      dexieVersion: nextVersion,
      appliedAt: Date.now(),
    })
  })
}

/**
 * Remove a plugin's tables from the shared CogniaDB instance.
 *
 * When retentionMode is "keep" (default), the stores are kept in the schema
 * but no data is deleted — the plugin can be re-enabled and resume from its
 * last state. When "purge", the stores are nulled out (Dexie's mechanism for
 * dropping a store) which permanently deletes the data.
 */
export async function removePluginTables(
  db: Dexie,
  pluginId: string,
  retentionMode: RetentionMode = "keep"
): Promise<void> {
  // Serialized against applyPluginTables/removePluginTables via the shared lock.
  await schemaMutex.runExclusive(async () => {
    const meta = await getPluginDexieMeta(pluginId)
    if (!meta) return // nothing registered, no-op

    if (retentionMode === "purge") {
      const patch: Record<string, null> = {}
      for (const name of meta.tableNames) {
        patch[name] = null
      }
      const nextVersion = db.verno + 1
      await db.close()
      db.version(nextVersion).stores(patch)
      await db.open()
    }

    await deletePluginDexiaMeta(pluginId)
  })
}
