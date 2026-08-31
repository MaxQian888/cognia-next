/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"

import { CURRENT_SCHEMA_VERSION } from "./schema"
import {
  STORAGE_LAYOUT,
  STORAGE_LAYOUT_ID,
  STORAGE_LAYOUT_TABLE,
  UnsupportedLocalSchemaError,
  assertStorageLayoutSupported,
  resetLocalDatabase,
  writeStorageLayoutMarker,
  type StorageLayoutDependencies,
  type StorageLayoutMarker,
} from "./storage-layout"

function fakeProbe(tables: string[], marker?: Partial<StorageLayoutMarker>) {
  const close = jest.fn()
  return {
    close,
    probe: {
      open: jest.fn().mockResolvedValue(undefined),
      tables: tables.map((name) => ({ name })),
      table: () => ({ get: jest.fn().mockResolvedValue(marker) }),
      close,
    } as unknown as Dexie,
  }
}

function deps(over: Partial<StorageLayoutDependencies> = {}): StorageLayoutDependencies {
  return {
    databaseExists: jest.fn().mockResolvedValue(true),
    openProbe: () => fakeProbe([STORAGE_LAYOUT_TABLE]).probe,
    deleteDatabase: jest.fn().mockResolvedValue(undefined),
    ...over,
  }
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof UnsupportedLocalSchemaError) return error.reason
    throw error
  }
  throw new Error("expected UnsupportedLocalSchemaError")
}

describe("assertStorageLayoutSupported", () => {
  it("allows a database that does not exist yet", async () => {
    const openProbe = jest.fn()
    await assertStorageLayoutSupported(
      "fresh",
      deps({ databaseExists: jest.fn().mockResolvedValue(false), openProbe })
    )
    // Probing would CREATE the database, so a fresh install must not be probed.
    expect(openProbe).not.toHaveBeenCalled()
  })

  it("refuses a database with no marker store at all", async () => {
    // The pre-collapse shape: real stores, but nothing that identifies which
    // layout wrote them.
    const { probe } = fakeProbe(["sessions", "messages"])
    expect(
      await reasonOf(assertStorageLayoutSupported("old", deps({ openProbe: () => probe })))
    ).toBe("missing-marker")
  })

  it("allows a marker store that exists but holds no row", async () => {
    // The crash window between this build creating the database and the marker
    // being written. Refusing here would reject a database we made ourselves.
    const { probe } = fakeProbe([STORAGE_LAYOUT_TABLE], undefined)
    await expect(
      assertStorageLayoutSupported("half-written", deps({ openProbe: () => probe }))
    ).resolves.toBeUndefined()
  })

  it("refuses a different storage layout", async () => {
    const { probe } = fakeProbe([STORAGE_LAYOUT_TABLE], {
      id: STORAGE_LAYOUT_ID,
      layout: "profile-target",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      writtenAt: 1,
    })
    expect(
      await reasonOf(assertStorageLayoutSupported("split", deps({ openProbe: () => probe })))
    ).toBe("layout-mismatch")
  })

  it("refuses a database written by a newer build", async () => {
    const { probe } = fakeProbe([STORAGE_LAYOUT_TABLE], {
      id: STORAGE_LAYOUT_ID,
      layout: STORAGE_LAYOUT,
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      writtenAt: 1,
    })
    expect(
      await reasonOf(assertStorageLayoutSupported("newer", deps({ openProbe: () => probe })))
    ).toBe("newer-schema")
  })

  it("allows an older schema version within the same layout", async () => {
    // Adding a store to CURRENT_SCHEMA and bumping is an ordinary forward move.
    // Only a HIGHER stored version is unsafe.
    const { probe } = fakeProbe([STORAGE_LAYOUT_TABLE], {
      id: STORAGE_LAYOUT_ID,
      layout: STORAGE_LAYOUT,
      schemaVersion: CURRENT_SCHEMA_VERSION - 1,
      writtenAt: 1,
    })
    await expect(
      assertStorageLayoutSupported("older", deps({ openProbe: () => probe }))
    ).resolves.toBeUndefined()
  })

  it("closes the probe even when it refuses", async () => {
    const { probe, close } = fakeProbe(["sessions"])
    await reasonOf(assertStorageLayoutSupported("old", deps({ openProbe: () => probe })))
    expect(close).toHaveBeenCalled()
  })
})

describe("resetLocalDatabase", () => {
  it("throws when the database survives the delete", async () => {
    // A delete that silently did nothing would loop the user through the same
    // refusal on every launch with no way out, so it is verified.
    await expect(
      resetLocalDatabase(
        "stubborn",
        deps({
          deleteDatabase: jest.fn().mockResolvedValue(undefined),
          databaseExists: jest.fn().mockResolvedValue(true),
        })
      )
    ).rejects.toThrow(/could not be deleted/)
  })

  it("resolves once the database is gone", async () => {
    await expect(
      resetLocalDatabase("gone", deps({ databaseExists: jest.fn().mockResolvedValue(false) }))
    ).resolves.toBeUndefined()
  })
})

describe("against a real IndexedDB", () => {
  const legacyName = "storage-layout-legacy"
  const markedName = "storage-layout-marked"

  afterEach(async () => {
    await Dexie.delete(legacyName)
    await Dexie.delete(markedName)
  })

  it("refuses a real database written without the marker store", async () => {
    const legacy = new Dexie(legacyName)
    legacy.version(1).stores({ sessions: "id" })
    await legacy.open()
    await legacy.table("sessions").put({ id: "kept" })
    legacy.close()

    expect(await reasonOf(assertStorageLayoutSupported(legacyName))).toBe("missing-marker")

    // Refusing is not deleting. The rows are still there for the user to decide about.
    const after = new Dexie(legacyName)
    await after.open()
    expect(await after.table("sessions").get("kept")).toEqual({ id: "kept" })
    after.close()
  })

  it("accepts a real database this build stamped", async () => {
    const db = new Dexie(markedName)
    db.version(1).stores({ [STORAGE_LAYOUT_TABLE]: "id" })
    await db.open()
    await writeStorageLayoutMarker(db as never)
    db.close()

    await expect(assertStorageLayoutSupported(markedName)).resolves.toBeUndefined()
  })

  it("rewrites the marker idempotently", async () => {
    const db = new Dexie(markedName)
    db.version(1).stores({ [STORAGE_LAYOUT_TABLE]: "id" })
    await db.open()
    await writeStorageLayoutMarker(db as never)
    await writeStorageLayoutMarker(db as never)
    expect(await db.table(STORAGE_LAYOUT_TABLE).count()).toBe(1)
    const row = (await db.table(STORAGE_LAYOUT_TABLE).get(STORAGE_LAYOUT_ID)) as StorageLayoutMarker
    expect(row.layout).toBe(STORAGE_LAYOUT)
    expect(row.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })
})
