/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { CogniaAccountRegistryDB } from "@/lib/accounts/account-db"
import {
  PERFORMANCE_ACCOUNT_QUOTA_BYTES,
  PerformanceQuotaExceededError,
  PerformanceQuotaManager,
} from "./quota"

describe("PerformanceQuotaManager", () => {
  let db: CogniaAccountRegistryDB
  let manager: PerformanceQuotaManager

  beforeEach(async () => {
    db = new CogniaAccountRegistryDB(`perf-quota-${crypto.randomUUID()}`)
    await db.open()
    manager = new PerformanceQuotaManager(db)
  })

  afterEach(async () => {
    manager.close()
    await db.delete()
  })

  it("reserves worst case before converting to actual committed usage", async () => {
    const reservation = await manager.reserve({
      accountId: "account-a",
      targetDatabase: "db-a",
      captureId: "capture-a",
      worstCaseBytes: 1000,
      now: 1,
    })
    expect(await manager.usage("account-a")).toBe(1000)
    await manager.commit(reservation.id, 400, 2)
    expect(await manager.usage("account-a")).toBe(400)
  })

  it("rejects a reservation that would exceed the account-wide 2 GiB quota", async () => {
    await manager.reserve({
      accountId: "account-a",
      targetDatabase: "db-a",
      captureId: "capture-a",
      worstCaseBytes: PERFORMANCE_ACCOUNT_QUOTA_BYTES,
    })
    await expect(
      manager.reserve({
        accountId: "account-a",
        targetDatabase: "db-b",
        captureId: "capture-b",
        worstCaseBytes: 1,
      })
    ).rejects.toBeInstanceOf(PerformanceQuotaExceededError)
  })

  it("keeps crash leftovers counted until reconciliation enumerates target databases", async () => {
    await manager.reserve({
      accountId: "account-a",
      targetDatabase: "db-a",
      captureId: "capture-a",
      worstCaseBytes: 1000,
    })
    expect(await manager.usage("account-a")).toBe(1000)
    await manager.reconcile("account-a", [])
    expect(await manager.usage("account-a")).toBe(0)
  })
})
