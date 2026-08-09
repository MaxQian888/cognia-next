import Dexie from "dexie"

import { installFakeIndexedDb } from "./node-indexeddb"

describe("installFakeIndexedDb", () => {
  it("installs a window shim + fake indexedDB onto a bare global", async () => {
    const g: Record<string, unknown> = {}
    await installFakeIndexedDb(g)
    expect(g.window).toBe(g)
    expect(g.indexedDB).toBeDefined()
    expect(g.IDBKeyRange).toBeDefined()
    // Dexie's module-level dependency snapshot is re-pointed.
    expect(Dexie.dependencies.indexedDB).toBeDefined()
  })

  it("is idempotent and non-clobbering", async () => {
    const existingWindow = { marker: true }
    const existingIdb = { marker: "idb" }
    const g: Record<string, unknown> = {
      window: existingWindow,
      indexedDB: existingIdb,
    }
    await installFakeIndexedDb(g)
    expect(g.window).toBe(existingWindow)
    expect(g.indexedDB).toBe(existingIdb)

    // Second call on a fresh global also works.
    const g2: Record<string, unknown> = {}
    await installFakeIndexedDb(g2)
    await installFakeIndexedDb(g2)
    expect(g2.window).toBe(g2)
  })

  it("rebinds a stale non-empty Dexie dependency snapshot", async () => {
    const savedIdb = Dexie.dependencies.indexedDB
    const savedRange = Dexie.dependencies.IDBKeyRange
    const staleIdb = {} as IDBFactory
    const staleRange = {} as typeof IDBKeyRange
    const currentIdb = {} as IDBFactory
    const currentRange = {} as typeof IDBKeyRange

    try {
      Dexie.dependencies.indexedDB = staleIdb
      Dexie.dependencies.IDBKeyRange = staleRange
      await installFakeIndexedDb({ indexedDB: currentIdb, IDBKeyRange: currentRange })
      expect(Dexie.dependencies.indexedDB).toBe(currentIdb)
      expect(Dexie.dependencies.IDBKeyRange).toBe(currentRange)
    } finally {
      Dexie.dependencies.indexedDB = savedIdb
      Dexie.dependencies.IDBKeyRange = savedRange
    }
  })

  it("replaces Node-style storage accessors without invoking their getters", async () => {
    const g: Record<string, unknown> = {}
    const getter = jest.fn(() => {
      throw new Error("warning-producing accessor was read")
    })
    Object.defineProperty(g, "localStorage", {
      configurable: true,
      get: getter,
    })

    await expect(installFakeIndexedDb(g)).resolves.toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
    expect(typeof (g.localStorage as Storage).getItem).toBe("function")
  })

  it("opens a real Dexie database against the shim", async () => {
    const g: Record<string, unknown> = {}
    await installFakeIndexedDb(g)
    const db = new Dexie("headless-shim-probe", {
      indexedDB: g.indexedDB as IDBFactory,
      IDBKeyRange: g.IDBKeyRange as typeof IDBKeyRange,
    })
    db.version(1).stores({ items: "id" })
    await db.table("items").put({ id: "a", value: 1 })
    const row = await db.table("items").get("a")
    expect(row).toEqual({ id: "a", value: 1 })
    db.close()
  })
})
