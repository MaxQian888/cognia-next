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
type DexieSource = Dexie | (() => Dexie)

/**
 * A single process-wide lock serializing every schema mutation. The schema
 * bump is a read-modify-write on the shared Dexie instance (`nextSchemaVersion
 * → close → version().stores() → open()`); two plugins enabling concurrently
 * would otherwise read the same version, race close/open, and silently clobber
 * one schema patch. The lock keeps loads + activate() parallel while making
 * only this critical section mutually exclusive. Reuses `createMutex`.
 */
const schemaMutex = createMutex()

const SCHEMA_LOCK_PREFIX = "cognia-plugin-schema:"

interface SchemaLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

/**
 * Serialize schema mutations both inside this realm and across same-origin
 * tabs/Tauri webviews. A module mutex alone is realm-local, so two windows can
 * otherwise perform competing version upgrades against the same IndexedDB.
 */
function runSchemaMutationExclusive<T>(dbName: string, operation: () => Promise<T>): Promise<T> {
  return schemaMutex.runExclusive(() => {
    const locks = (globalThis as { navigator?: { locks?: SchemaLockManager } }).navigator?.locks
    if (!locks?.request) return operation()
    return locks.request(`${SCHEMA_LOCK_PREFIX}${dbName}`, operation)
  })
}

function resolveDb(source: DexieSource): Dexie {
  return typeof source === "function" ? source() : source
}

/**
 * The next Dexie version to declare for a schema bump, derived from the TRUE
 * persisted native IndexedDB version rather than `db.verno`.
 *
 * `db.verno` reflects only the versions THIS Dexie instance has been told about
 * in code — on a fresh process that is just the static core ceiling declared by
 * `new CogniaDB(...)` (e.g. 104). But plugin-table bumps advance the *physical*
 * IndexedDB native version above that ceiling and persist across reloads (and a
 * "keep"-mode disable leaves the physical store — and the elevated native
 * version — in place while dropping the meta row). Declaring `db.verno + 1` can
 * therefore land on, or below, a version the physical DB already passed. Dexie
 * then sees the code schema as a superset of the stored schema at an equal-or-
 * lower version number, logs
 *   "Dexie SchemaDiff: Schema was extended without increasing the number passed
 *    to db.version(). Dexie will add missing parts and increment native version
 *    number to workaround this."
 * and silently force-upgrades with a rogue native bump — which then collides
 * with any other open connection ("Upgrade '…' blocked by other connection
 * holding version N").
 *
 * `db.backendDB().version` (available once the db is open) is the ground truth:
 * the native IDB version, which Dexie stores as `verno * 10`. Taking the max of
 * that and `db.verno` guarantees the next declared version strictly exceeds
 * everything already persisted, so every bump is a clean, explicit upgrade with
 * no SchemaDiff auto-bump. Opening the db first is a no-op when it is already
 * open and has no side effect on a brand-new db (native version == verno * 10).
 */
async function nextSchemaVersion(db: Dexie): Promise<number> {
  if (!db.isOpen()) await db.open()
  const nativeVerno = Math.round(db.backendDB().version / 10)
  return Math.max(db.verno, nativeVerno) + 1
}

/**
 * Apply a plugin's declared Dexie tables to the shared CogniaDB instance.
 *
 * Safe to call multiple times for the same plugin (idempotent when the table
 * set hasn't changed). Throws if the plugin has already registered tables and
 * the table list has changed — the caller should call removePluginTables first
 * and then re-apply.
 */
export async function applyPluginTables(
  dbSource: DexieSource,
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
  const dbName = resolveDb(dbSource).name
  await runSchemaMutationExclusive(dbName, async () => {
    // A foreign upgrade request can close and replace the cached CogniaDB while
    // this call waits for the Web Lock. Resolve it only after lock acquisition
    // so the schema is applied to the instance plugin activation will consume.
    const db = resolveDb(dbSource)
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

    const nextVersion = await nextSchemaVersion(db)
    db.close()
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
 * in ONE close→version(nextSchemaVersion).stores(patch)→open pass. Plugins absent from
 * the map (uninstalled, but with a lingering meta row) are skipped — their
 * stores are left untouched for `removePluginTables` to reclaim.
 *
 * Must run before plugin activation (restorePluginStates / the "startup"
 * activation event) so `ctx.dexie` is ready when activate() runs.
 *
 * @returns the namespaced table names that were re-declared (empty if none).
 */
export async function restorePluginTables(
  dbSource: DexieSource,
  manifestDexie: Map<string, PluginManifestDexieBlock>,
  options: { registerMissing?: boolean } = {}
): Promise<string[]> {
  // Serialized against applyPluginTables/removePluginTables via the shared lock
  // so the launch-time consolidated bump can't race a concurrent enable.
  const dbName = resolveDb(dbSource).name
  return runSchemaMutationExclusive(dbName, async () => {
    const db = resolveDb(dbSource)
    const metas = await getAllPluginDexiaMeta()
    if (metas.length === 0 && !options.registerMissing) return []
    const metaByPluginId = new Map(metas.map((meta) => [meta.pluginId, meta]))

    // `db.tables` is Dexie's CODE-declared schema — on a fresh process it holds
    // only the static core, never the plugin stores, even though those stores
    // still exist physically in IndexedDB. `objectStoreNames` is the physical
    // ground truth: a store listed here already exists and only needs Dexie to
    // be TOLD about it (an adopt), not a native-version upgrade to create it.
    if (!db.isOpen()) await db.open()
    const liveTables = new Set(db.tables.map((t) => t.name))
    const physicalStores = new Set(Array.from(db.backendDB().objectStoreNames))
    const patch: Record<string, string> = {}
    // Whether any store to declare must actually be CREATED (absent physically).
    // If every declared store already exists physically we adopt them at the
    // current native version instead of bumping past it — otherwise every boot
    // re-upgrades stores that were never gone, drifting the native version up by
    // one per launch (WKWebView never commits those perpetual upgrades → wedge).
    let requiresCreate = false

    const candidates = options.registerMissing
      ? manifestDexie.entries()
      : metas
          .map((meta) => [meta.pluginId, manifestDexie.get(meta.pluginId)] as const)
          .filter(
            (entry): entry is readonly [string, PluginManifestDexieBlock] => entry[1] !== undefined
          )
    const registrations: Array<{ pluginId: string; tableNames: string[] }> = []

    for (const [pluginId, dexieBlock] of candidates) {
      if (!dexieBlock) continue // plugin gone; leave its meta for removePluginTables
      if (dexieBlock.tables.length > MAX_TABLES_PER_PLUGIN) {
        throw new Error(
          `Plugin "${pluginId}" declares ${dexieBlock.tables.length} tables, exceeding the maximum of ${MAX_TABLES_PER_PLUGIN}`
        )
      }
      const tableNames = dexieBlock.tables.map((table) =>
        toNamespacedTableName(pluginId, table.name)
      )
      const existingMeta = metaByPluginId.get(pluginId)
      const existingNames = new Set(existingMeta?.tableNames ?? [])
      if (
        !existingMeta ||
        existingNames.size !== tableNames.length ||
        tableNames.some((name) => !existingNames.has(name))
      ) {
        registrations.push({ pluginId, tableNames })
      }
      for (const t of dexieBlock.tables) {
        const nsName = toNamespacedTableName(pluginId, t.name)
        if (liveTables.has(nsName)) continue // already declared this session
        patch[nsName] = t.schema
        if (!physicalStores.has(nsName)) requiresCreate = true
      }
    }

    const restored = Object.keys(patch)
    if (restored.length === 0) {
      for (const registration of registrations) {
        await putPluginDexiaMeta({
          ...registration,
          dexieVersion: db.verno,
          appliedAt: Date.now(),
        })
      }
      return []
    }

    // Adopt-in-place when nothing must be created: declare at the max of the
    // code ceiling and the persisted native version WITHOUT the +1, so Dexie
    // records the existing stores in its schema snapshot but runs no upgrade
    // transaction. A genuinely-missing store still forces a clean explicit bump.
    const nativeVerno = Math.round(db.backendDB().version / 10)
    const targetVersion = requiresCreate
      ? await nextSchemaVersion(db)
      : Math.max(db.verno, nativeVerno)
    db.close()
    db.version(targetVersion).stores(patch)
    await db.open()
    for (const registration of registrations) {
      await putPluginDexiaMeta({
        ...registration,
        dexieVersion: targetVersion,
        appliedAt: Date.now(),
      })
    }
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
  dbSource: DexieSource,
  pluginId: string,
  retentionMode: RetentionMode = "keep"
): Promise<void> {
  // Serialized against applyPluginTables/removePluginTables via the shared lock.
  const dbName = resolveDb(dbSource).name
  await runSchemaMutationExclusive(dbName, async () => {
    const db = resolveDb(dbSource)
    const meta = await getPluginDexieMeta(pluginId)
    if (!meta) return // nothing registered, no-op

    if (retentionMode === "purge") {
      const patch: Record<string, null> = {}
      for (const name of meta.tableNames) {
        patch[name] = null
      }
      const nextVersion = await nextSchemaVersion(db)
      db.close()
      db.version(nextVersion).stores(patch)
      await db.open()
    }

    await deletePluginDexiaMeta(pluginId)
  })
}
