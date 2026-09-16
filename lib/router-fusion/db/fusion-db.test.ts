import "fake-indexeddb/auto"

import Dexie from "dexie"

import {
  FUSION_DB_SCHEMA_VERSION,
  FUSION_SCHEMA,
  FUSION_TABLE_NAMES,
  __resetFusionDbForTesting,
  fusionDatabaseName,
  getFusionDb,
  isFusionDatabaseName,
  openFusionDb,
} from "./fusion-db"

describe("fusion database lifecycle", () => {
  afterEach(() => __resetFusionDbForTesting())

  it("derives its name from the main database so it follows accounts and targets", () => {
    expect(fusionDatabaseName("cognia-account-acct_1-encrypted-v1")).toBe(
      "cognia-account-acct_1-encrypted-v1-router-fusion-v1"
    )
    expect(isFusionDatabaseName("cognia-account-acct_1-encrypted-v1-router-fusion-v1")).toBe(true)
    expect(isFusionDatabaseName("cognia-account-acct_1-encrypted-v1")).toBe(false)
    expect(() => fusionDatabaseName("")).toThrow()
  })

  it("declares every store it types", () => {
    const db = getFusionDb("main-a")
    expect(FUSION_TABLE_NAMES.sort()).toEqual(Object.keys(FUSION_SCHEMA).sort())
    for (const table of FUSION_TABLE_NAMES) expect(db[table]).toBeDefined()
  })

  it("keeps every earlier store's index layout across the B2 and B3 bumps", () => {
    // The schema is one version, not a chain: an existing database takes the
    // new layout as-is. Changing an index here would silently rebuild it on
    // every device, so each bump only ADDS stores (and B2 one index).
    expect(FUSION_DB_SCHEMA_VERSION).toBe(3)
    expect(FUSION_SCHEMA.fusionRuns).toContain("actorKeyId")
    expect(FUSION_SCHEMA.fusionIdempotency).toBe("&scopedKey, runId, expiresAt")
    expect(FUSION_SCHEMA.fusionFeedback).toBe("&feedbackId, runId, createdAt")
    expect(FUSION_SCHEMA.fusionApiSessions).toBe("&apiSessionId, sessionId, actorKeyId")
    expect(FUSION_SCHEMA.fusionToolOperations).toBe(
      "&operationId, runId, [runId+logicalStepId], createdAt"
    )
  })

  it("opens a database a B2 build created without losing a row", async () => {
    const name = fusionDatabaseName("main-upgrade")
    const {
      fusionApiSessions: _sessions,
      fusionToolOperations: _operations,
      ...b2Schema
    } = FUSION_SCHEMA
    const older = new Dexie(name)
    older.version(2).stores(b2Schema)
    await older.open()
    await older.table("fusionFeedback").put({ feedbackId: "f1", runId: "r1", createdAt: 1 })
    older.close()

    const upgraded = await openFusionDb("main-upgrade")
    expect(upgraded.verno).toBe(3)
    await expect(upgraded.fusionFeedback.get("f1")).resolves.toMatchObject({ runId: "r1" })
    await upgraded.fusionApiSessions.put({
      apiSessionId: "a1",
      sessionId: "s1",
      actorKeyId: "k",
      createdAt: 1,
    })
    await expect(upgraded.fusionApiSessions.where("sessionId").equals("s1").count()).resolves.toBe(
      1
    )
  })

  it("is not created until something opens it", async () => {
    getFusionDb("main-lazy")
    expect(await Dexie.exists(fusionDatabaseName("main-lazy"))).toBe(false)
    await openFusionDb("main-lazy")
    expect(await Dexie.exists(fusionDatabaseName("main-lazy"))).toBe(true)
  })

  it("closes the previous account's database when the main database changes", async () => {
    const first = await openFusionDb("main-1")
    const second = await openFusionDb("main-2")
    expect(first.isOpen()).toBe(false)
    expect(second.isOpen()).toBe(true)
    expect(getFusionDb("main-2")).toBe(second)
  })

  it("turns an open failure into an infrastructure fault", async () => {
    const db = getFusionDb("main-broken")
    jest.spyOn(db, "open").mockRejectedValueOnce(new Error("indexedDB blocked by policy"))
    await expect(openFusionDb("main-broken")).rejects.toMatchObject({
      name: "RouterFusionInfrastructureError",
      code: "db_unavailable",
    })
    // The broken instance is not reused.
    expect(getFusionDb("main-broken")).not.toBe(db)
  })

  it("steps aside when a deletion path deletes it while open", async () => {
    // Account deletion, target removal, the layout reset and "clear all data"
    // delete the database by name without loading this module; the open
    // instance must close instead of blocking them, and must not be reused.
    const db = await openFusionDb("main-delete")
    await Dexie.delete(fusionDatabaseName("main-delete"))
    expect(await Dexie.exists(fusionDatabaseName("main-delete"))).toBe(false)
    expect(db.isOpen()).toBe(false)
    expect(getFusionDb("main-delete")).not.toBe(db)
  })
})
