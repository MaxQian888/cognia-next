import "fake-indexeddb/auto"

jest.mock("@/lib/db/schema", () => ({
  getDb: () => {
    throw new Error("no account database in this test")
  },
}))

const usageRow = jest.fn(async () => "applied" as const)
jest.mock("../db/outbox-appliers", () => ({
  accountDatabaseAppliers: {
    usage_row: (...args: unknown[]) => usageRow(...(args as [])),
    execution_run_milestone: async () => "applied",
    execution_run_projection: async () => "applied",
  },
}))

import { __resetFusionDbForTesting } from "../db/fusion-db"
import {
  __resetFusionStoreForTesting,
  currentFusionStore,
  drainAccountOutbox,
} from "./store-provider"

describe("currentFusionStore", () => {
  afterEach(() => {
    __resetFusionStoreForTesting()
    __resetFusionDbForTesting()
  })

  it("reuses the store while the main database stays the same", async () => {
    const first = await currentFusionStore({ mainDatabaseName: () => "main-a" })
    const again = await currentFusionStore({ mainDatabaseName: () => "main-a" })
    expect(again).toBe(first)
    expect(first.db.name).toBe("main-a-router-fusion-v1")
  })

  it("follows an account switch to a different fusion database", async () => {
    const a = await currentFusionStore({ mainDatabaseName: () => "main-a" })
    const b = await currentFusionStore({ mainDatabaseName: () => "main-b" })
    expect(b).not.toBe(a)
    expect(b.db.name).toBe("main-b-router-fusion-v1")
  })

  it("applies the store's pending effects with the account database's appliers", async () => {
    const store = await currentFusionStore({ mainDatabaseName: () => "main-drain" })
    await store.db.fusionOutbox.add({
      effectId: "usage:a1",
      runId: "run-1",
      kind: "usage_row",
      payload: {},
      status: "pending",
      attempts: 0,
      lastError: null,
      createdAt: 1,
      appliedAt: null,
    })
    await expect(drainAccountOutbox(store)).resolves.toMatchObject({ applied: 1, failed: 0 })
    expect(usageRow).toHaveBeenCalledTimes(1)
    expect((await store.db.fusionOutbox.get("usage:a1"))?.status).toBe("applied")
  })

  it("reports a missing account database as an infrastructure fault", async () => {
    await expect(currentFusionStore()).rejects.toMatchObject({
      name: "RouterFusionInfrastructureError",
      code: "db_unavailable",
    })
  })
})
