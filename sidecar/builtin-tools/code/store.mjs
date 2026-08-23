// Store facade — selects the SQLite backend when `better-sqlite3` is available,
// otherwise the pure-JS in-memory backend. Mirrors the node-pty contract: a
// lazy require with a clean fallback, so a missing/ABI-mismatched native binary
// degrades the subsystem (no FTS ranking, no on-disk persistence) instead of
// crashing the session.

import { createRequire } from "node:module"

import { createMemoryStore } from "./store-memory.mjs"
import { createSqliteStore } from "./store-sqlite.mjs"

const require = createRequire(import.meta.url)

/** Prefer Bun's built-in SQLite, then retain the Node fallback for source hosts. */
export function loadSqliteBinding({
  bunRuntime = Boolean(process.versions.bun),
  requireModule = require,
} = {}) {
  if (bunRuntime) {
    try {
      const mod = requireModule("bun:sqlite")
      if (typeof mod?.Database === "function") {
        return class BunSqliteDatabase extends mod.Database {
          constructor(dbPath) {
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
    return typeof mod === "function" ? mod : null
  } catch {
    return null
  }
}

/**
 * Create a code-graph store.
 * @param {{ dbPath?: string, forceMemory?: boolean }} [opts]
 *   dbPath — on-disk path (or ":memory:"); omit/forceMemory → in-memory JS store
 * @returns {{ binding: "sqlite" | "memory", [k: string]: any }}
 */
export function createStore({ dbPath, forceMemory = false } = {}) {
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
