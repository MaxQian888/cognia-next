// Store facade — selects the SQLite backend when `better-sqlite3` is available,
// otherwise the pure-JS in-memory backend. Mirrors the node-pty contract: a
// lazy require with a clean fallback, so a missing/ABI-mismatched native binary
// degrades the subsystem (no FTS ranking, no on-disk persistence) instead of
// crashing the session.

import { createRequire } from "node:module"

import { createMemoryStore } from "./store-memory.ts"
import type { CodeGraphStore } from "./store-memory.ts"
import { createSqliteStore } from "./store-sqlite.ts"
import type { SqliteDatabase, SqliteDatabaseCtor } from "./store-sqlite.ts"

const require = createRequire(import.meta.url)

/** Prefer Bun's built-in SQLite, then retain the Node fallback for source hosts. */
export function loadSqliteBinding({
  bunRuntime = Boolean(process.versions.bun),
  requireModule = require as (id: string) => unknown,
}: {
  bunRuntime?: boolean
  requireModule?: (id: string) => unknown
} = {}): SqliteDatabaseCtor | null {
  if (bunRuntime) {
    try {
      const mod = requireModule("bun:sqlite") as { Database?: unknown } | null | undefined
      if (typeof mod?.Database === "function") {
        const BunDatabase = mod.Database as new (
          dbPath: string,
          options: { strict: boolean }
        ) => SqliteDatabase
        return class BunSqliteDatabase extends BunDatabase {
          constructor(dbPath: string) {
            super(dbPath, { strict: true })
          }
        }
      }
    } catch {
      // Fall through for partial/older Bun runtimes.
    }
  }
  try {
    const mod = requireModule("better-sqlite3")
    return typeof mod === "function" ? (mod as SqliteDatabaseCtor) : null
  } catch {
    return null
  }
}

/**
 * Create a code-graph store. `dbPath` is an on-disk path (or ":memory:");
 * omitting it, or `forceMemory`, gives the in-memory JS store.
 */
export function createStore({
  dbPath,
  forceMemory = false,
}: { dbPath?: string | undefined; forceMemory?: boolean } = {}): CodeGraphStore {
  if (!forceMemory && dbPath) {
    const Database = loadSqliteBinding()
    if (Database) {
      try {
        return createSqliteStore(dbPath, Database)
      } catch {
        // Corrupt DB / locked / disk issue → fall through to memory.
      }
    }
  }
  return createMemoryStore()
}
