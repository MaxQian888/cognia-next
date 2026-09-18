/**
 * Tests for lib/db/notification-timers.ts — cancellable scheduled work.
 * Covers arming, the due sweep, the cancelToken CAS on fire, and the
 * match-based cancellation sweep (ACK / revocation / read-state cancel).
 */

import { createDbTestFixture } from "./test-fixture"
import {
  armNotificationTimer,
  listDueTimers,
  fireNotificationTimer,
  cancelTimersFor,
  listArmedTimersForFact,
} from "./notification-timers"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const SCOPE = "scope-A"

function input(over: Partial<Parameters<typeof armNotificationTimer>[0]> = {}) {
  return {
    scopeKey: SCOPE,
    kind: over.kind ?? "quiet-release",
    dueAt: over.dueAt ?? Date.now() + 60_000,
    ...(over.factKey ? { factKey: over.factKey } : {}),
    ...(over.intentId ? { intentId: over.intentId } : {}),
    ...(over.aggregateKey ? { aggregateKey: over.aggregateKey } : {}),
    ...(over.notificationId ? { notificationId: over.notificationId } : {}),
    ...(over.cancelToken ? { cancelToken: over.cancelToken } : {}),
  }
}

describe("armNotificationTimer", () => {
  it("arms a timer with a fresh cancelToken", async () => {
    const row = await armNotificationTimer(input({ factKey: "f1" }))
    expect(row.state).toBe("armed")
    expect(row.cancelToken).toBeTruthy()
    expect(row.factKey).toBe("f1")
  })

  it("honors a caller-supplied cancelToken (replacing an existing timer)", async () => {
    const row = await armNotificationTimer(input({ cancelToken: "shared-token" }))
    expect(row.cancelToken).toBe("shared-token")
  })
})

describe("listDueTimers", () => {
  it("returns only armed timers due at/before now", async () => {
    const due = await armNotificationTimer(input({ dueAt: Date.now() - 1 }))
    await armNotificationTimer(input({ dueAt: Date.now() + 60_000 }))
    const rows = await listDueTimers()
    expect(rows.map((t) => t.id)).toEqual([due.id])
  })
})

describe("fireNotificationTimer", () => {
  it("fires an armed timer when the token matches", async () => {
    const row = await armNotificationTimer(input())
    const fired = await fireNotificationTimer(row.id, row.cancelToken)
    expect(fired?.state).toBe("fired")
  })

  it("refuses to fire when the token was rotated (stale read)", async () => {
    const row = await armNotificationTimer(input())
    // A cancellation lands between read and fire — rotates the token.
    await cancelTimersFor({ kind: "quiet-release" }, "test-cancel")
    const fired = await fireNotificationTimer(row.id, row.cancelToken)
    expect(fired).toBeUndefined()
  })

  it("refuses to fire an already-fired timer", async () => {
    const row = await armNotificationTimer(input())
    await fireNotificationTimer(row.id, row.cancelToken)
    const again = await fireNotificationTimer(row.id, row.cancelToken)
    expect(again).toBeUndefined()
  })
})

describe("cancelTimersFor", () => {
  it("cancels armed timers matching the fact key", async () => {
    await armNotificationTimer(input({ factKey: "target", kind: "escalation" }))
    await armNotificationTimer(input({ factKey: "other", kind: "escalation" }))
    const n = await cancelTimersFor({ factKey: "target" }, "acked")
    expect(n).toBe(1)
    expect(await listArmedTimersForFact("target")).toHaveLength(0)
    expect(await listArmedTimersForFact("other")).toHaveLength(1)
  })

  it("cancels by kind + intent id", async () => {
    await armNotificationTimer(input({ kind: "retry", intentId: "i1" }))
    await armNotificationTimer(input({ kind: "retry", intentId: "i2" }))
    const n = await cancelTimersFor({ kind: "retry", intentId: "i1" }, "superseded")
    expect(n).toBe(1)
  })

  it("records the cancel reason", async () => {
    const row = await armNotificationTimer(input({ factKey: "fx" }))
    await cancelTimersFor({ factKey: "fx" }, "user-acked")
    const { getDb } = await import("./schema")
    const stored = await getDb().notificationTimers.get(row.id)
    expect(stored?.state).toBe("cancelled")
    expect(stored?.cancelReason).toBe("user-acked")
  })
})

describe("listArmedTimersForFact", () => {
  it("returns only armed timers for the fact", async () => {
    await armNotificationTimer(input({ factKey: "f" }))
    const fired = await armNotificationTimer(input({ factKey: "f", dueAt: Date.now() - 1 }))
    await fireNotificationTimer(fired.id, fired.cancelToken)
    const armed = await listArmedTimersForFact("f")
    expect(armed).toHaveLength(1)
    expect(armed[0].state).toBe("armed")
  })
})
