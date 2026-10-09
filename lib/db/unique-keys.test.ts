import "fake-indexeddb/auto"

import Dexie, { type Table } from "dexie"

import { uniqueIndexKeys } from "./unique-keys"

interface Row {
  id: string
  sessionId: string
}

class TestDb extends Dexie {
  rows!: Table<Row, string>
  constructor(name: string) {
    super(name)
    this.version(1).stores({ rows: "id, sessionId" })
  }
}

// WebKit's failure for a unique-direction cursor over an empty range.
function webkitEmptyUniqueCursorError(): Error {
  return Object.assign(new Error("Unable to open cursor"), { name: "UnknownError" })
}

let db: TestDb
let dbIndex = 0

beforeEach(async () => {
  db = new TestDb(`unique-keys-test-${dbIndex++}`)
  await db.rows.bulkPut([
    { id: "1", sessionId: "a" },
    { id: "2", sessionId: "a" },
    { id: "3", sessionId: "b" },
  ])
})

afterEach(async () => {
  jest.restoreAllMocks()
  db.close()
  await db.delete()
})

type CollectionProto = {
  _ctx: { unique: string }
  keys: (...args: unknown[]) => Promise<unknown[]>
  uniqueKeys: () => Promise<unknown>
}

function collectionProto(): CollectionProto {
  return Object.getPrototypeOf(db.rows.toCollection()) as CollectionProto
}

// WebKit's behavior: a unique-direction cursor that matches nothing fails
// instead of resolving empty. Dexie's `uniqueKeys()` is `keys()` with the
// context marked unique, so failing `keys()` there reproduces it end to end,
// including a probe that would wrongly inherit the flag.
function emulateWebKitUniqueCursor() {
  const proto = collectionProto()
  const keys = proto.keys
  return jest.spyOn(proto, "keys").mockImplementation(async function (
    this: CollectionProto,
    ...args: unknown[]
  ) {
    const result = await keys.apply(this, args)
    if (this._ctx.unique && result.length === 0) throw webkitEmptyUniqueCursorError()
    return result
  })
}

function stubUniqueKeys(error: Error) {
  return jest.spyOn(collectionProto(), "uniqueKeys").mockRejectedValue(error)
}

describe("uniqueIndexKeys", () => {
  it("returns the distinct index keys like uniqueKeys", async () => {
    emulateWebKitUniqueCursor()
    expect(await uniqueIndexKeys(db.rows.orderBy("sessionId"))).toEqual(["a", "b"])
    expect(await uniqueIndexKeys(db.rows.where("sessionId").anyOf(["b", "z"]))).toEqual(["b"])
  })

  it("returns [] when WebKit refuses the unique cursor over an empty range", async () => {
    emulateWebKitUniqueCursor()

    expect(await uniqueIndexKeys(db.rows.where("sessionId").anyOf(["x", "y"]))).toEqual([])
  })

  it("returns [] for an empty table", async () => {
    await db.rows.clear()
    emulateWebKitUniqueCursor()

    expect(await uniqueIndexKeys(db.rows.orderBy("sessionId"))).toEqual([])
  })

  it("rethrows an UnknownError when the range does hold records", async () => {
    const error = webkitEmptyUniqueCursorError()
    stubUniqueKeys(error)

    await expect(uniqueIndexKeys(db.rows.where("sessionId").equals("a"))).rejects.toBe(error)
  })

  it("leaves the caller's collection reusable as a plain query", async () => {
    const collection = db.rows.where("sessionId").anyOf(["a"])
    expect(await uniqueIndexKeys(collection)).toEqual(["a"])
    expect(await collection.primaryKeys()).toEqual(["1", "2"])
  })

  it("rethrows any other error without probing", async () => {
    const error = Object.assign(new Error("boom"), { name: "AbortError" })
    stubUniqueKeys(error)

    await expect(uniqueIndexKeys(db.rows.where("sessionId").anyOf(["x"]))).rejects.toBe(error)
  })

  it("keeps an enclosing transaction alive after the fallback", async () => {
    emulateWebKitUniqueCursor()

    await db.transaction("rw", db.rows, async () => {
      expect(await uniqueIndexKeys(db.rows.where("sessionId").anyOf(["x"]))).toEqual([])
      await db.rows.put({ id: "4", sessionId: "c" })
    })

    expect(await db.rows.get("4")).toEqual({ id: "4", sessionId: "c" })
  })
})
