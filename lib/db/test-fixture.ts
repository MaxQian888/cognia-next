import "fake-indexeddb/auto"

import {
  __enableDbRuntimeForTesting,
  __resetDbForTesting,
  getDb,
  whenSeeded,
  type CogniaDB,
} from "./schema"

export const DB_TEST_TIMEOUT_MS = 30_000

// Jest 30 can retain its five-second runtime default for hooks in a later
// worker even when a multi-project config reports a larger testTimeout. Every
// suite importing this fixture performs a full-schema open at least once, so
// bind the finite budget at the test-runtime boundary as well.
jest.setTimeout(DB_TEST_TIMEOUT_MS)

interface TableSnapshot {
  name: string
  values: unknown[]
}

export interface DbTestFixtureOptions {
  /** Preserve the built-in seed rows between tests. Defaults to true. */
  seeded?: boolean
  /** Tables that should be empty in the restored baseline. */
  emptyTables?: readonly string[]
}

export interface DbTestFixture {
  initialize(): Promise<void>
  restore(): Promise<void>
  dispose(): Promise<void>
  registerCleanup(cleanup: () => void | Promise<void>): () => void
}

async function clearTables(db: CogniaDB, tableNames: readonly string[]): Promise<void> {
  const tables = tableNames.map((name) => {
    const table = db.tables.find((candidate) => candidate.name === name)
    if (!table) throw new Error(`Unknown CogniaDB table in test fixture: ${name}`)
    return table
  })

  if (tables.length === 0) return
  await db.transaction("rw", tables, async () => {
    for (const table of tables) await table.clear()
  })
}

async function captureDatabase(db: CogniaDB): Promise<TableSnapshot[]> {
  return db.transaction("r", db.tables, () =>
    Promise.all(
      db.tables.map(async (table) => ({
        name: table.name,
        values: (await table.toArray()) as unknown[],
      }))
    )
  )
}

async function restoreDatabase(db: CogniaDB, snapshots: readonly TableSnapshot[]): Promise<void> {
  await db.transaction("rw", db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()))
    await Promise.all(
      snapshots
        .filter((snapshot) => snapshot.values.length > 0)
        .map((snapshot) => db.table(snapshot.name).bulkPut(snapshot.values))
    )
  })
}

export function createDbTestFixture(options: DbTestFixtureOptions = {}): DbTestFixture {
  const seeded = options.seeded ?? true
  const emptyTables = [...new Set(options.emptyTables ?? [])]
  const cleanups = new Set<() => void | Promise<void>>()
  let releaseRuntime: (() => void) | null = null
  let snapshots: TableSnapshot[] | null = null
  let poisoned: unknown = null

  const runCleanups = async () => {
    const pending = [...cleanups].reverse()
    cleanups.clear()
    const errors: unknown[] = []
    for (const cleanup of pending) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "Database test fixture cleanup failed")
  }

  const deleteCurrentDatabase = async () => {
    try {
      await getDb().delete()
    } finally {
      __resetDbForTesting()
    }
  }

  return {
    async initialize() {
      if (releaseRuntime) throw new Error("Database test fixture is already initialized")
      releaseRuntime = __enableDbRuntimeForTesting()
      try {
        await deleteCurrentDatabase()
        const db = getDb()
        await whenSeeded()
        if (!seeded)
          await clearTables(
            db,
            db.tables.map((table) => table.name)
          )
        else await clearTables(db, emptyTables)
        snapshots = await captureDatabase(db)
      } catch (error) {
        try {
          await deleteCurrentDatabase()
        } finally {
          releaseRuntime()
          releaseRuntime = null
        }
        throw error
      }
    },

    async restore() {
      if (poisoned) throw new Error("Database test fixture cannot recover after a failed restore")
      if (!releaseRuntime || !snapshots) {
        throw new Error("Database test fixture must be initialized before restore")
      }

      try {
        await runCleanups()
        const db = getDb()
        db.close()
        await db.open()
        await restoreDatabase(db, snapshots)
      } catch (error) {
        poisoned = error
        await deleteCurrentDatabase()
        throw error
      }
    },

    async dispose() {
      if (!releaseRuntime) return
      try {
        const errors: unknown[] = []
        try {
          await runCleanups()
        } catch (error) {
          errors.push(error)
        }
        try {
          await deleteCurrentDatabase()
        } catch (error) {
          errors.push(error)
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) {
          throw new AggregateError(errors, "Database test fixture disposal failed")
        }
      } finally {
        snapshots = null
        poisoned = null
        releaseRuntime()
        releaseRuntime = null
      }
    },

    registerCleanup(cleanup) {
      if (!releaseRuntime) {
        throw new Error("Database test fixture must be initialized before registering cleanup")
      }
      cleanups.add(cleanup)
      return () => cleanups.delete(cleanup)
    },
  }
}
