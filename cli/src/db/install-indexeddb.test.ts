/**
 * @jest-environment node
 */
// The preamble MUST be imported before `dexie`, exactly as the CLI entry does:
// Dexie snapshots `globalThis.indexedDB` the moment its module is first
// evaluated, so the global has to exist first. Importing it second here would
// reproduce the very bug this module fixes.
import "./install-indexeddb"

import Dexie from "dexie"

describe("install-indexeddb preamble", () => {
  it("installs a usable IndexedDB API on the global", () => {
    const g = globalThis as unknown as { indexedDB?: IDBFactory }
    expect(g.indexedDB).toBeDefined()
    expect(typeof g.indexedDB?.open).toBe("function")
  })

  it("binds Dexie.dependencies so eagerly-constructed databases find the API", () => {
    expect(Dexie.dependencies.indexedDB).toBeTruthy()
    expect(Dexie.dependencies.IDBKeyRange).toBeTruthy()
  })

  it("lets a Dexie database constructed AFTER the import open and read", async () => {
    const db = new Dexie("install-indexeddb-spec-db")
    db.version(1).stores({ items: "id" })
    await db.open()
    const items = db.table<{ id: string }, string>("items")
    await items.add({ id: "a" })
    expect(await items.toArray()).toEqual([{ id: "a" }])
    db.close()
    await db.delete()
  })
})
