import "fake-indexeddb/auto"
import Dexie from "dexie"
import { createDexieAPI } from "./dexie-api"

function makePluginDb(pluginId: string, tableName: string): Dexie {
  const db = new Dexie(`test-dexie-api-${Math.random().toString(36).slice(2)}`)
  db.version(1).stores({
    [`${pluginId}:${tableName}`]: "++id, name",
  })
  return db
}

describe("createDexieAPI", () => {
  let db: Dexie

  afterEach(async () => {
    await db?.delete()
  })

  it("table() returns the namespaced Dexie table", () => {
    db = makePluginDb("github-delivery", "repos")
    const api = createDexieAPI(db, "github-delivery")
    const table = api.table("repos")
    expect(table.name).toBe("github-delivery:repos")
  })

  it("rawDb() returns the underlying Dexie instance", () => {
    db = makePluginDb("github-delivery", "repos")
    const api = createDexieAPI(db, "github-delivery")
    expect(api.rawDb()).toBe(db)
  })

  it("table() with another plugin prefix embedded in the name is caught by namespace check", () => {
    // If a plugin tries to craft a name like "other:repos", the namespaced
    // name becomes "github-delivery:other:repos" whose parsed pluginId would be
    // "github-delivery" so it still passes the guard — but the underlying Dexie
    // table won't exist. That's fine: Dexie throws on non-existent table.
    db = makePluginDb("github-delivery", "repos")
    const api = createDexieAPI(db, "github-delivery")
    // A plugin trying to sneak in another plugin's table:
    // "github-delivery" + ":" + "bad-plugin:data" → "github-delivery:bad-plugin:data"
    // fromNamespacedTableName would return { pluginId: "github-delivery", tableName: "bad-plugin:data" }
    // so the pluginId check passes, but Dexie.table() throws "Table not found".
    expect(() => api.table("bad-plugin:data")).toThrow()
  })

  it("table() with empty name throws because fromNamespacedTableName returns null", () => {
    db = makePluginDb("github-delivery", "repos")
    const api = createDexieAPI(db, "github-delivery")
    expect(() => api.table("")).toThrow(/not in its namespace/)
  })

  it("two plugins with the same logical table name get separate tables", () => {
    const dbA = new Dexie(`test-plugin-a-${Math.random().toString(36).slice(2)}`)
    dbA.version(1).stores({ "plugin-a:items": "++id", "plugin-b:items": "++id, name" })
    db = dbA

    const apiA = createDexieAPI(dbA, "plugin-a")
    const apiB = createDexieAPI(dbA, "plugin-b")

    expect(apiA.table("items").name).toBe("plugin-a:items")
    expect(apiB.table("items").name).toBe("plugin-b:items")
  })
})
