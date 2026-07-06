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
import { createMutex } from "@cognia/primitives"
import { toNamespacedTableName, MAX_TABLES_PER_PLUGIN } from "./namespace"
import {
  getPluginDexieMeta,
  getAllPluginDexiaMeta,
  putPluginDexiaMeta,
  deletePluginDexiaMeta,
} from "./meta"

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
      if (setsEqual) {
        // Defense in depth: the meta says these tables are registered, but the
        // live schema can drift away from it. `new CogniaDB(...)` re-declares
        // only the static core schema, so on a fresh process the namespaced
        // stores are absent from `db.tables` even though the meta row persists
        // (an aborted upgrade or partial purge desyncs the same way). If every
        // declared store is actually present the early-return is safe;
        // otherwise fall through and re-bump so the missing stores are
        // re-declared instead of letting the plugin's activate() throw
        // "Table <id>:<name> does not exist".
        const liveTables = new Set(db.tables.map((t) => t.name))
        if (namespacedNames.every((n) => liveTables.has(n))) return // already applied
      }
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
 * Re-declare persisted plugin tables into the live Dexie schema at launch.
 *
 * `new CogniaDB(...)` declares only the static core schema; plugin tables live
 * at dynamically-bumped versions above that ceiling and are NOT re-declared by
 * the constructor. So on every fresh process the namespaced stores are missing
 * from `db.tables` even though they physically exist in IndexedDB and
 * `pluginDexieMeta` still records them. Left unhandled, the idempotent
 * early-return in `applyPluginTables` then wrongly skips the bump and the
 * plugin's `activate()` throws "Table <id>:<name> does not exist".
 *
 * This reads every `pluginDexieMeta` row, resolves each plugin's schema strings
 * from the supplied manifest map (the authoritative source — meta stores only
 * table names, not index definitions), and re-applies every still-missing table
 * in ONE close→version(verno+1).stores(patch)→open pass. Plugins absent from
 * the map (uninstalled, but with a lingering meta row) are skipped — their
 * stores are left untouched for `removePluginTables` to reclaim.
 *
 * Must run before plugin activation (restorePluginStates / the "startup"
 * activation event) so `ctx.dexie` is ready when activate() runs.
 *
 * @returns the namespaced table names that were re-declared (empty if none).
 */
export async function restorePluginTables(
  db: Dexie,
  manifestDexie: Map<string, PluginManifestDexieBlock>
): Promise<string[]> {
  // Serialized against applyPluginTables/removePluginTables via the shared lock
  // so the launch-time consolidated bump can't race a concurrent enable.
  return schemaMutex.runExclusive(async () => {
    const metas = await getAllPluginDexiaMeta()
    if (metas.length === 0) return []

    const liveTables = new Set(db.tables.map((t) => t.name))
    const patch: Record<string, string> = {}

    for (const meta of metas) {
      const dexieBlock = manifestDexie.get(meta.pluginId)
      if (!dexieBlock) continue // plugin gone; leave its meta for removePluginTables
      for (const t of dexieBlock.tables) {
        const nsName = toNamespacedTableName(meta.pluginId, t.name)
        if (liveTables.has(nsName)) continue // already declared this session
        patch[nsName] = t.schema
      }
    }

    const restored = Object.keys(patch)
    if (restored.length === 0) return []

    const nextVersion = db.verno + 1
    await db.close()
    db.version(nextVersion).stores(patch)
    await db.open()
    return restored
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
