import type { PluginManifestDexieBlock } from "@/types/plugin"
import { createMutex } from "@cognia/primitives"

import { restorePluginTables } from "@/lib/plugin/dexie/bridge"
import { getBuiltinPluginDexieManifests } from "@/lib/plugin/dexie/builtin-manifests"
import { toNamespacedTableName } from "@/lib/plugin/dexie/namespace"
import { getDb, recreateActiveDatabaseForSchemaUpgrade, type CogniaDB, whenSeeded } from "./schema"

interface PersistedPluginManifestRow {
  manifest?: unknown
}

export interface DatabaseBootResult {
  databaseName: string
  restoredPluginTables: string[]
}

export interface DatabaseBootDependencies {
  getDatabase: () => CogniaDB
  getBuiltinPluginManifests: () => Map<string, PluginManifestDexieBlock>
  restorePluginSchema: (
    source: () => CogniaDB,
    manifests: Map<string, PluginManifestDexieBlock>,
    options?: {
      registerMissing?: boolean
      requiredStoreNames?: readonly string[]
      recreateDatabase?: () => CogniaDB
    }
  ) => Promise<string[]>
  recreateDatabase: () => CogniaDB
  verifySchema: (database: CogniaDB, manifests: Map<string, PluginManifestDexieBlock>) => void
  seed: () => Promise<void>
}

const defaultDependencies: DatabaseBootDependencies = {
  getDatabase: getDb,
  getBuiltinPluginManifests: getBuiltinPluginDexieManifests,
  restorePluginSchema: restorePluginTables,
  recreateDatabase: recreateActiveDatabaseForSchemaUpgrade,
  verifySchema: assertPluginSchemaReady,
  seed: whenSeeded,
}

const bootByDatabase = new WeakMap<CogniaDB, Promise<DatabaseBootResult>>()
const bootMutexByDatabaseName = new Map<string, ReturnType<typeof createMutex>>()
const DATABASE_BOOT_LOCK_PREFIX = "cognia-database-boot:"

interface DatabaseBootLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

function runDatabaseBootExclusive<T>(
  databaseName: string,
  operation: () => Promise<T>
): Promise<T> {
  let mutex = bootMutexByDatabaseName.get(databaseName)
  if (!mutex) {
    mutex = createMutex()
    bootMutexByDatabaseName.set(databaseName, mutex)
  }
  return mutex.runExclusive(() => {
    const locks = (globalThis as { navigator?: { locks?: DatabaseBootLockManager } }).navigator
      ?.locks
    if (!locks?.request) return operation()
    return locks.request(`${DATABASE_BOOT_LOCK_PREFIX}${databaseName}`, operation)
  })
}

/**
 * Prepare the selected account/target database before any feature initializer
 * is allowed to consume it. Concurrent callers share one ordered open → plugin
 * schema adoption → seed attempt. A rejection is evicted so account unlock can
 * retry without reusing a permanently rejected promise.
 */
export function ensureActiveDatabaseReady(
  dependencies: DatabaseBootDependencies = defaultDependencies
): Promise<DatabaseBootResult> {
  const database = dependencies.getDatabase()
  const existing = bootByDatabase.get(database)
  if (existing) return existing

  const attempt = runDatabaseBootExclusive(database.name, async () => {
    // Capture the static code schema before opening. When a plugin mutation has
    // already advanced IndexedDB beyond a later core migration, WKWebView opens
    // at the higher physical version and Dexie can drop the skipped core stores
    // from its live table list. The recovery bridge needs this pre-open snapshot
    // to force one explicit version bump that materializes those stores.
    const requiredStoreNames = database.tables.map((table) => table.name)
    await database.open()
    const pluginRows = await database.plugins.toArray()
    const manifests = collectPersistedPluginDexieManifests(pluginRows)
    for (const [pluginId, dexie] of dependencies.getBuiltinPluginManifests()) {
      if (!manifests.has(pluginId)) manifests.set(pluginId, dexie)
    }
    const restoredPluginTables = await dependencies.restorePluginSchema(
      () => dependencies.getDatabase(),
      manifests,
      {
        registerMissing: true,
        requiredStoreNames,
        recreateDatabase: dependencies.recreateDatabase,
      }
    )

    const active = dependencies.getDatabase()
    if (active.name !== database.name) {
      throw new Error(
        `Active database changed during boot (${database.name} → ${active.name}); retry required.`
      )
    }
    dependencies.verifySchema(active, manifests)
    await dependencies.seed()
    return { databaseName: active.name, restoredPluginTables }
  })

  bootByDatabase.set(database, attempt)
  void attempt.catch(() => {
    if (bootByDatabase.get(database) === attempt) bootByDatabase.delete(database)
  })
  return attempt
}

/** Fail closed if a plugin declaration was not adopted by both Dexie and IndexedDB. */
export function assertPluginSchemaReady(
  database: CogniaDB,
  manifests: Map<string, PluginManifestDexieBlock>
): void {
  const declaredNativeVersion = Math.round(database.verno * 10)
  const backend = database.backendDB()
  if (backend.version < declaredNativeVersion) {
    throw new Error(
      `Database ${database.name} native version ${backend.version} is below declared version ${declaredNativeVersion}.`
    )
  }

  const dexieTables = new Set(database.tables.map((table) => table.name))
  const nativeTables = new Set(Array.from(backend.objectStoreNames))
  const missing: string[] = []
  for (const [pluginId, dexie] of manifests) {
    for (const table of dexie.tables) {
      const name = toNamespacedTableName(pluginId, table.name)
      if (!dexieTables.has(name) || !nativeTables.has(name)) missing.push(name)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Database ${database.name} did not adopt declared plugin stores: ${missing.join(", ")}`
    )
  }
}

/** Extract only structurally valid dynamic-table declarations from persisted plugins. */
export function collectPersistedPluginDexieManifests(
  rows: PersistedPluginManifestRow[]
): Map<string, PluginManifestDexieBlock> {
  const manifests = new Map<string, PluginManifestDexieBlock>()
  for (const row of rows) {
    if (!row.manifest || typeof row.manifest !== "object") continue
    const manifest = row.manifest as Record<string, unknown>
    if (typeof manifest.id !== "string" || !manifest.id) continue
    const dexie = manifest.dexie
    if (!dexie || typeof dexie !== "object") continue
    const tables = (dexie as { tables?: unknown }).tables
    if (!Array.isArray(tables)) continue
    if (
      !tables.every(
        (table) =>
          table !== null &&
          typeof table === "object" &&
          typeof (table as { name?: unknown }).name === "string" &&
          typeof (table as { schema?: unknown }).schema === "string"
      )
    ) {
      continue
    }
    manifests.set(manifest.id, dexie as PluginManifestDexieBlock)
  }
  return manifests
}
