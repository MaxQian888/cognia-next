/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  CLEANUP_INITIAL_DELAY_MS,
  CLEANUP_INTERVAL_MS,
  LEGACY_GRACE_MS,
  cleanupExpiredCallbackBindings,
  startCallbackBindingCleanupSchedule,
} from "./callback-binding-cleanup"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"

const NOW = 1_750_000_000_000

async function seed(rows: ConnectorCallbackBindingRow[]): Promise<void> {
  await getDb().connectorCallbackBindings.bulkPut(rows)
}

function makeRow(
  id: string,
  overrides: Partial<ConnectorCallbackBindingRow> = {}
): ConnectorCallbackBindingRow {
  return {
    id,
    adapterId: "tg-1",
    actionId: id,
    kind: "callback_query",
    surfaceId: "s1",
    componentId: "btn1",
    conversationKey: "tg:c1",
    createdAt: NOW - 1000,
    expiresAt: undefined,
    ...overrides,
  }
}

beforeEach(async () => {
  try {
    await getDb().delete()
  } catch {
    // Initial run before a DB exists — `delete()` may throw; safe to ignore.
  }
  __resetDbForTesting()
  getDb()
})

describe("cleanupExpiredCallbackBindings", () => {
  it("deletes rows whose expiresAt has passed", async () => {
    await seed([
      makeRow("a", { expiresAt: NOW - 1 }),
      makeRow("b", { expiresAt: NOW + 1000 }),
      makeRow("c", { expiresAt: NOW - 5_000 }),
    ])

    const result = await cleanupExpiredCallbackBindings({ now: NOW })

    expect(result.expiredCount).toBe(2)
    expect(result.legacyCount).toBe(0)
    expect(result.total).toBe(2)
    const remaining = await getDb().connectorCallbackBindings.toArray()
    expect(remaining.map((r) => r.id).sort()).toEqual(["b"])
  })

  it("keeps rows with expiresAt strictly in the future", async () => {
    await seed([makeRow("future", { expiresAt: NOW + 60_000 })])
    const result = await cleanupExpiredCallbackBindings({ now: NOW })
    expect(result.total).toBe(0)
    expect(await getDb().connectorCallbackBindings.count()).toBe(1)
  })

  it("reaps legacy rows older than the grace window", async () => {
    const legacyOld = makeRow("legacy-old", {
      expiresAt: undefined,
      createdAt: NOW - LEGACY_GRACE_MS - 1,
    })
    const legacyYoung = makeRow("legacy-young", {
      expiresAt: undefined,
      createdAt: NOW - 1000,
    })
    await seed([legacyOld, legacyYoung])

    const result = await cleanupExpiredCallbackBindings({ now: NOW })

    expect(result.expiredCount).toBe(0)
    expect(result.legacyCount).toBe(1)
    expect(result.total).toBe(1)
    const remaining = await getDb().connectorCallbackBindings.toArray()
    expect(remaining.map((r) => r.id)).toEqual(["legacy-young"])
  })

  it("honours a custom legacyGraceMs override", async () => {
    await seed([makeRow("legacy", { expiresAt: undefined, createdAt: NOW - 5000 })])

    const tightResult = await cleanupExpiredCallbackBindings({ now: NOW, legacyGraceMs: 1000 })
    expect(tightResult.legacyCount).toBe(1)
    expect(await getDb().connectorCallbackBindings.count()).toBe(0)
  })

  it("returns zero counts when the table is empty", async () => {
    const result = await cleanupExpiredCallbackBindings({ now: NOW })
    expect(result).toEqual({ expiredCount: 0, legacyCount: 0, total: 0 })
  })

  it("returns zero counts when nothing has expired", async () => {
    await seed([
      makeRow("a", { expiresAt: NOW + 60_000 }),
      makeRow("b", { expiresAt: NOW + 90_000 }),
    ])
    const result = await cleanupExpiredCallbackBindings({ now: NOW })
    expect(result).toEqual({ expiredCount: 0, legacyCount: 0, total: 0 })
    expect(await getDb().connectorCallbackBindings.count()).toBe(2)
  })
})

describe("startCallbackBindingCleanupSchedule", () => {
  function buildFakeScheduler() {
    const calls: Array<{
      kind: "timeout" | "interval"
      cb: () => void
      ms: number
      handle: number
    }> = []
    let handleCounter = 0
    return {
      calls,
      setTimeout: jest.fn((cb: () => void, ms: number) => {
        const handle = ++handleCounter
        calls.push({ kind: "timeout", cb, ms, handle })
        return handle
      }),
      clearTimeout: jest.fn(),
      setInterval: jest.fn((cb: () => void, ms: number) => {
        const handle = ++handleCounter
        calls.push({ kind: "interval", cb, ms, handle })
        return handle
      }),
      clearInterval: jest.fn(),
    }
  }

  it("schedules the initial timeout but does not run synchronously", () => {
    const fake = buildFakeScheduler()
    const handle = startCallbackBindingCleanupSchedule({ scheduler: fake })
    expect(fake.setTimeout).toHaveBeenCalledTimes(1)
    expect(fake.setTimeout.mock.calls[0][1]).toBe(CLEANUP_INITIAL_DELAY_MS)
    expect(fake.setInterval).not.toHaveBeenCalled()
    handle.dispose()
  })

  it("fires the first sweep and starts the periodic interval after the initial delay", async () => {
    await seed([makeRow("a", { expiresAt: NOW - 1 })])
    const fake = buildFakeScheduler()
    let resolveSwept: ((value: void) => void) | null = null
    const sweptPromise = new Promise<void>((resolve) => {
      resolveSwept = resolve
    })
    const onSwept = jest.fn(() => {
      resolveSwept?.()
    })
    const handle = startCallbackBindingCleanupSchedule({
      scheduler: fake,
      now: () => NOW,
      onSwept,
    })

    // Trigger the initial timeout callback the schedule queued for us.
    const initial = fake.calls.find((c) => c.kind === "timeout")
    expect(initial).toBeDefined()
    initial!.cb()
    // Wait for the sweep's async pipeline to deliver onSwept.
    await sweptPromise

    expect(fake.setInterval).toHaveBeenCalledTimes(1)
    expect(fake.setInterval.mock.calls[0][1]).toBe(CLEANUP_INTERVAL_MS)
    expect(onSwept).toHaveBeenCalledWith(expect.objectContaining({ expiredCount: 1, total: 1 }))

    handle.dispose()
  })

  it("runNow() triggers a sweep immediately and resolves with the result", async () => {
    await seed([makeRow("a", { expiresAt: NOW - 1 })])
    const fake = buildFakeScheduler()
    const handle = startCallbackBindingCleanupSchedule({ scheduler: fake, now: () => NOW })

    const result = await handle.runNow()
    expect(result.total).toBe(1)
    handle.dispose()
  })

  it("dispose() clears both the initial timeout and the running interval", async () => {
    const fake = buildFakeScheduler()
    const handle = startCallbackBindingCleanupSchedule({ scheduler: fake })
    handle.dispose()

    expect(fake.clearTimeout).toHaveBeenCalled()
    // No interval started yet — clearInterval should still be a no-op call count zero.
    expect(fake.clearInterval).not.toHaveBeenCalled()

    // Disposing a second time is a no-op (no double-clear).
    handle.dispose()
    expect(fake.clearTimeout).toHaveBeenCalledTimes(1)
  })

  it("dispose() after the interval is running clears both handles", async () => {
    const fake = buildFakeScheduler()
    const handle = startCallbackBindingCleanupSchedule({ scheduler: fake, now: () => NOW })
    const initial = fake.calls.find((c) => c.kind === "timeout")!
    initial.cb()
    await Promise.resolve()
    await Promise.resolve()
    handle.dispose()

    expect(fake.clearTimeout).toHaveBeenCalledTimes(1)
    expect(fake.clearInterval).toHaveBeenCalledTimes(1)
  })

  it("swallows onSwept errors so the schedule continues running", async () => {
    await seed([makeRow("a", { expiresAt: NOW - 1 })])
    const fake = buildFakeScheduler()
    const handle = startCallbackBindingCleanupSchedule({
      scheduler: fake,
      now: () => NOW,
      onSwept: () => {
        throw new Error("telemetry boom")
      },
    })

    const result = await handle.runNow()
    expect(result.total).toBe(1)
    handle.dispose()
  })
})
