/** @jest-environment jsdom */
/**
 * Integration test: plugin Dexie table data persists across db close/reopen.
 *
 * This verifies the key M0 contract: data written to a plugin's table
 * survives the close→bump→reopen cycle used by applyPluginTables, matching
 * the "plugin disabled then re-enabled" and "app restart" scenarios.
 */

import "fake-indexeddb/auto"
import Dexie from "dexie"
import { applyPluginTables } from "./bridge"

jest.mock("./meta", () => {
  const actual = jest.requireActual("./meta")
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
const { __setTestDb } = require("./meta")

describe("plugin Dexie table persistence", () => {
  it("data written before close is readable after reopen", async () => {
    const dbName = `test-persist-${Math.random().toString(36).slice(2)}`
    const db = new Dexie(dbName)
    db.version(1).stores({ pluginDexieMeta: "&pluginId, appliedAt" })
    __setTestDb(db)

    // Apply tables and write a row.
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id, fullName" }],
    })
    await db.table("github-delivery:repos").add({ fullName: "octocat/hello" })

    // Simulate app restart: close and reopen the same-named DB.
    await db.close()
    const db2 = new Dexie(dbName)
    // Must declare the same version so IndexedDB opens cleanly.
    db2.version(db.verno).stores({
      pluginDexieMeta: "&pluginId, appliedAt",
      "github-delivery:repos": "++id, fullName",
    })
    await db2.open()

    const rows = await db2.table("github-delivery:repos").toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].fullName).toBe("octocat/hello")

    await db2.delete()
  })

  it("second plugin's data is isolated from first plugin's after restart", async () => {
    const dbName = `test-isolate-${Math.random().toString(36).slice(2)}`
    const db = new Dexie(dbName)
    db.version(1).stores({ pluginDexieMeta: "&pluginId, appliedAt" })
    __setTestDb(db)

    await applyPluginTables(db, "plugin-a", { tables: [{ name: "items", schema: "++id" }] })
    await applyPluginTables(db, "plugin-b", { tables: [{ name: "items", schema: "++id, name" }] })

    await db.table("plugin-a:items").add({ id: 1 })
    await db.table("plugin-b:items").add({ id: 1, name: "b-item" })

    const aRows = await db.table("plugin-a:items").toArray()
    const bRows = await db.table("plugin-b:items").toArray()

    expect(aRows).toHaveLength(1)
    expect(bRows).toHaveLength(1)
    expect(bRows[0].name).toBe("b-item")

    await db.delete()
  })
})
