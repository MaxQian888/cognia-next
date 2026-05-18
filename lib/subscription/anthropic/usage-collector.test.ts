/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import {
  _resetPersistDebounce,
  recordUsageSnapshot,
  subscribeToUsageHeaders,
} from "./usage-collector"
import type { UsageSnapshot } from "../core/types"

const onClaudeMessageMock = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  onClaudeMessage: (...args: unknown[]) => onClaudeMessageMock(...args),
}))

import { getDb, __resetDbForTesting } from "@/lib/db/schema"

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    fetchedAt: Date.now(),
    source: "passive",
    status: "allowed",
    representativeClaim: "five_hour",
    fiveHour: { utilization: 0.1, resetAt: Date.now() + 5 * 3600_000, status: "allowed" },
    sevenDay: { utilization: 0.5, resetAt: Date.now() + 7 * 86400_000, status: "allowed" },
    fallbackPercentage: 0.2,
    overageDisabledReason: null,
    rawHeaders: { "anthropic-ratelimit-unified-status": "allowed" },
    ...overrides,
  }
}

beforeEach(async () => {
  jest.resetAllMocks()
  _resetPersistDebounce()
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

describe("recordUsageSnapshot", () => {
  it("writes a row and assigns a localId", async () => {
    const row = await recordUsageSnapshot(snapshot({ fetchedAt: 1000 }))
    expect(row).not.toBeNull()
    expect(row!.localId).toBeGreaterThan(0)
    const all = await getDb().subscriptionUsage.toArray()
    expect(all).toHaveLength(1)
  })

  it("debounces writes from the same source within 60s", async () => {
    const a = await recordUsageSnapshot(snapshot({ fetchedAt: 1000 }))
    const b = await recordUsageSnapshot(snapshot({ fetchedAt: 30_000 }))
    expect(a).not.toBeNull()
    expect(b).toBeNull()
    expect(await getDb().subscriptionUsage.count()).toBe(1)
  })

  it("does not debounce across sources", async () => {
    const a = await recordUsageSnapshot(snapshot({ source: "passive", fetchedAt: 1000 }))
    const b = await recordUsageSnapshot(snapshot({ source: "probe", fetchedAt: 2000 }))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(await getDb().subscriptionUsage.count()).toBe(2)
  })

  it("trims oldest rows when over the cap", async () => {
    const db = getDb()
    const rows: UsageSnapshot[] = []
    for (let i = 0; i < 1001; i++) {
      rows.push(snapshot({ fetchedAt: i }))
    }
    await db.subscriptionUsage.bulkAdd(rows.map((r) => ({ ...r })))
    expect(await db.subscriptionUsage.count()).toBe(1001)

    const written = await recordUsageSnapshot(snapshot({ fetchedAt: 99999999 }))
    expect(written).not.toBeNull()
    expect(await db.subscriptionUsage.count()).toBe(1000)
    const oldest = await db.subscriptionUsage.orderBy("fetchedAt").first()
    expect(oldest?.fetchedAt).toBeGreaterThan(0)
  })
})

describe("subscribeToUsageHeaders", () => {
  it("forwards usage_headers events through the parser into Dexie", async () => {
    let listener: ((event: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementation(async (cb) => {
      listener = cb
      return () => {}
    })

    await subscribeToUsageHeaders()
    expect(listener).not.toBeNull()

    listener!({
      type: "usage_headers",
      headers: {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.42",
        "anthropic-ratelimit-unified-5h-reset": "1700000000",
      },
    })
    await new Promise((r) => setTimeout(r, 0))

    const all = await getDb().subscriptionUsage.toArray()
    expect(all).toHaveLength(1)
    expect(all[0].fiveHour?.utilization).toBe(0.42)
    expect(all[0].source).toBe("passive")
  })

  it("ignores non-usage events and events with no usage headers", async () => {
    let listener: ((event: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementation(async (cb) => {
      listener = cb
      return () => {}
    })

    await subscribeToUsageHeaders()
    listener!({ type: "ready" })
    listener!({ type: "usage_headers", headers: { "x-other": "1" } })
    await new Promise((r) => setTimeout(r, 0))

    expect(await getDb().subscriptionUsage.count()).toBe(0)
  })
})
