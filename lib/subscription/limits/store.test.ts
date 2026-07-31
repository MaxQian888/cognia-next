/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { latestLimitsSnapshot, recordLimitsSnapshot } from "./store"
import type { ProviderLimits } from "@/types/subscription"

import { getDb, __resetDbForTesting } from "@/lib/db/schema"

function snapshot(overrides: Partial<ProviderLimits> = {}): ProviderLimits {
  return {
    provider: "anthropic",
    accountId: "acc-1",
    accountLabel: "Pro",
    fetchedAt: Date.now(),
    meters: [
      { id: "session", labelKey: "k", kind: "window", usedPct: 21, resetAt: 1000, status: "ok" },
    ],
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

describe("recordLimitsSnapshot", () => {
  it("writes a row and assigns a localId", async () => {
    const row = await recordLimitsSnapshot(snapshot({ fetchedAt: 1000 }))
    expect(row.localId).toBeGreaterThan(0)
    expect(await getDb().providerLimits.count()).toBe(1)
  })

  it("caps the table at 500 newest-first", async () => {
    for (let i = 0; i < 503; i++) {
      await recordLimitsSnapshot(snapshot({ fetchedAt: i + 1 }))
    }
    const count = await getDb().providerLimits.count()
    expect(count).toBe(500)
    const all = await getDb().providerLimits.toArray()
    const minFetched = Math.min(...all.map((r) => r.fetchedAt))
    expect(minFetched).toBe(4)
  })
})

describe("latestLimitsSnapshot", () => {
  it("returns null when the account has no snapshot", async () => {
    expect(await latestLimitsSnapshot("anthropic", "nope")).toBeNull()
  })

  it("returns the newest snapshot for one provider account", async () => {
    await recordLimitsSnapshot(snapshot({ fetchedAt: 100 }))
    await recordLimitsSnapshot(snapshot({ fetchedAt: 300 }))
    await recordLimitsSnapshot(snapshot({ fetchedAt: 200 }))
    await recordLimitsSnapshot(snapshot({ provider: "codex", accountId: "acc-1", fetchedAt: 999 }))
    const latest = await latestLimitsSnapshot("anthropic", "acc-1")
    expect(latest?.fetchedAt).toBe(300)
    // The codex row with the same accountId must not bleed across providers.
    expect(latest?.provider).toBe("anthropic")
  })
})
