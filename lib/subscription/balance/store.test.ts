/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { latestBalanceSnapshot, recordBalanceSnapshot } from "./store"
import type { BalanceSnapshot } from "@/types/subscription"

import { getDb, __resetDbForTesting } from "@/lib/db/schema"

function snapshot(overrides: Partial<BalanceSnapshot> = {}): BalanceSnapshot {
  return {
    fetchedAt: Date.now(),
    providerKey: "deepseek",
    accountId: "acc-1",
    kind: "credit",
    currency: "CNY",
    unit: "CNY",
    remaining: 42,
    raw: { is_available: true },
    ...overrides,
  }
}

beforeEach(async () => {
  if (typeof indexedDB !== "undefined") {
    const databases = await indexedDB.databases?.()
    if (databases) {
      for (const info of databases) {
        if (info.name)
          await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(info.name!)
            req.onsuccess = req.onerror = req.onblocked = () => resolve(undefined)
          })
      }
    }
  }
  __resetDbForTesting()
})

describe("recordBalanceSnapshot", () => {
  it("writes a row and assigns a localId", async () => {
    const row = await recordBalanceSnapshot(snapshot({ fetchedAt: 1000 }))
    expect(row.localId).toBeGreaterThan(0)
    expect(await getDb().subscriptionBalance.count()).toBe(1)
  })

  it("caps the table at 500 newest-first", async () => {
    for (let i = 0; i < 503; i++) {
      await recordBalanceSnapshot(snapshot({ fetchedAt: i + 1 }))
    }
    const count = await getDb().subscriptionBalance.count()
    expect(count).toBe(500)
    // The three oldest (fetchedAt 1..3) were evicted.
    const all = await getDb().subscriptionBalance.toArray()
    const minFetched = Math.min(...all.map((r) => r.fetchedAt))
    expect(minFetched).toBe(4)
  })
})

describe("latestBalanceSnapshot", () => {
  it("returns null when the account has no snapshot", async () => {
    expect(await latestBalanceSnapshot("nope")).toBeNull()
  })

  it("returns the newest snapshot for an account", async () => {
    await recordBalanceSnapshot(snapshot({ fetchedAt: 100, remaining: 1 }))
    await recordBalanceSnapshot(snapshot({ fetchedAt: 300, remaining: 3 }))
    await recordBalanceSnapshot(snapshot({ fetchedAt: 200, remaining: 2 }))
    await recordBalanceSnapshot(snapshot({ accountId: "other", fetchedAt: 999, remaining: 9 }))
    const latest = await latestBalanceSnapshot("acc-1")
    expect(latest?.fetchedAt).toBe(300)
    expect(latest?.remaining).toBe(3)
  })
})
