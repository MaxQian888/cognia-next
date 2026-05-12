/**
 * dexie-bridge tests
 *
 * Tests for applyPluginTables and removePluginTables, including:
 *  - Single-plugin table registration
 *  - Multi-plugin namespace isolation (two plugins, same logical name)
 *  - Idempotent re-apply when tables haven't changed
 *  - removePluginTables with retain vs purge modes
 *  - MAX_TABLES_PER_PLUGIN enforcement
 */

import "fake-indexeddb/auto"
import Dexie from "dexie"
import { applyPluginTables, removePluginTables } from "./dexie-bridge"
import { getPluginDexieMeta } from "./dexie-meta"

// We bypass CogniaDB entirely and spin up a lightweight test Dexie instance
// that includes the pluginDexieMeta table but nothing else.
function makeTestDb(): Dexie {
  const db = new Dexie(`test-bridge-${Math.random().toString(36).slice(2)}`)
  db.version(1).stores({ pluginDexieMeta: "&pluginId, appliedAt" })
  return db
}

// Override getDb() inside dexie-bridge so it uses our test instance.
// We achieve this by monkey-patching the dexie-meta module which is the
// only place getDb() is called from the bridge.
jest.mock("./dexie-meta", () => {
  const actual = jest.requireActual("./dexie-meta")
  // We need a shared reference so we can swap it per test.
  let _db: Dexie | null = null
  return {
    ...actual,
    __setTestDb: (db: Dexie) => {
      _db = db
    },
    getPluginDexieMeta: async (pluginId: string) => {
      if (!_db) return undefined
      return (_db as Dexie & { pluginDexieMeta: Dexie.Table }).pluginDexieMeta.get(pluginId)
    },
    putPluginDexiaMeta: async (row: unknown) => {
      if (!_db) return
      await (_db as Dexie & { pluginDexieMeta: Dexie.Table }).pluginDexieMeta.put(row)
    },
    deletePluginDexiaMeta: async (pluginId: string) => {
      if (!_db) return
      await (_db as Dexie & { pluginDexieMeta: Dexie.Table }).pluginDexieMeta.delete(pluginId)
    },
  }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __setTestDb } = require("./dexie-meta")

describe("applyPluginTables", () => {
  let db: Dexie

  beforeEach(() => {
    db = makeTestDb()
    __setTestDb(db)
  })

  afterEach(async () => {
    await db.delete()
  })

  it("registers plugin tables with the namespace prefix", async () => {
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id, fullName" }],
    })

    expect(db.tables.map((t) => t.name)).toContain("github-delivery:repos")
  })

  it("stores meta row in pluginDexieMeta", async () => {
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id, fullName" }],
    })

    const meta = await getPluginDexieMeta("github-delivery")
    expect(meta).toBeDefined()
    expect(meta!.pluginId).toBe("github-delivery")
    expect(meta!.tableNames).toContain("github-delivery:repos")
  })

  it("two plugins declaring the same logical name do not collide", async () => {
    await applyPluginTables(db, "plugin-a", {
      tables: [{ name: "items", schema: "++id" }],
    })
    await applyPluginTables(db, "plugin-b", {
      tables: [{ name: "items", schema: "++id, name" }],
    })

    const tableNames = db.tables.map((t) => t.name)
    expect(tableNames).toContain("plugin-a:items")
    expect(tableNames).toContain("plugin-b:items")
  })

  it("is idempotent when called again with the same table set", async () => {
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id" }],
    })
    const versionAfterFirst = db.verno

    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id" }],
    })
    const versionAfterSecond = db.verno

    // No bump on a no-op re-apply.
    expect(versionAfterSecond).toBe(versionAfterFirst)
  })

  it("throws when more than MAX_TABLES_PER_PLUGIN tables are declared", async () => {
    const tables = Array.from({ length: 21 }, (_, i) => ({
      name: `table${i}`,
      schema: "++id",
    }))
    await expect(applyPluginTables(db, "big-plugin", { tables })).rejects.toThrow(
      /exceeding the maximum/
    )
  })
})

describe("removePluginTables", () => {
  let db: Dexie

  beforeEach(() => {
    db = makeTestDb()
    __setTestDb(db)
  })

  afterEach(async () => {
    await db.delete()
  })

  it("removes the meta row in retain mode (keeps the store)", async () => {
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id" }],
    })

    await removePluginTables(db, "github-delivery", "keep")

    const meta = await getPluginDexieMeta("github-delivery")
    expect(meta).toBeUndefined()
    // The store is still in the schema (data preserved).
    expect(db.tables.map((t) => t.name)).toContain("github-delivery:repos")
  })

  it("is a no-op for a plugin with no registered tables", async () => {
    await expect(removePluginTables(db, "unknown-plugin", "keep")).resolves.toBeUndefined()
  })

  it("purge mode drops stores and removes meta", async () => {
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id, fullName" }],
    })
    expect(db.tables.map((t) => t.name)).toContain("github-delivery:repos")

    await removePluginTables(db, "github-delivery", "purge")

    const meta = await getPluginDexieMeta("github-delivery")
    expect(meta).toBeUndefined()
    expect(db.tables.map((t) => t.name)).not.toContain("github-delivery:repos")
  })
})
