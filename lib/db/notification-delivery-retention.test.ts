/**
 * Tests for lib/db/notification-delivery-retention.ts — what the delivery
 * ledger keeps once a delivery settles past the notification retention window.
 *
 * Dexie runs on fake-indexeddb via createDbTestFixture (jsdom project).
 */

import { createDbTestFixture } from "./test-fixture"
import { getDb } from "./schema"
import { getIntentByOperationKey, transitionIntent } from "./notification-delivery"
import { pruneNotificationDelivery } from "./notification-delivery-retention"
import { judgeMateriality, materialHashOfFacts } from "@/lib/notifications/result/materiality"
import type {
  NotificationAggregateMember,
  NotificationDeliveryAttempt,
  NotificationIntentStatus,
  NotificationPublication,
  NotificationTimer,
  WholeNotificationDeliveryIntent,
} from "@/types/notifications/delivery"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const CUTOFF = NOW - 30 * DAY
const OLD = CUTOFF - DAY
const YOUNG = CUTOFF + DAY

function intent(
  id: string,
  status: NotificationIntentStatus,
  updatedAt: number,
  over: Partial<WholeNotificationDeliveryIntent> = {}
): WholeNotificationDeliveryIntent {
  return {
    id,
    scopeKey: "scope",
    scope: { namespaceId: "n", accountId: "a", authorityHostId: "h" },
    operationKey: `op-${id}`,
    targetId: "target",
    targetAddress: {
      kind: "connector",
      adapterId: "lark",
      conversationKey: "oc_room",
      deliveryTarget: { chatId: "oc_room" } as never,
    },
    targetVersion: 1,
    purpose: "result-summary",
    category: "run.result",
    status,
    payload: {
      title: "Deploy finished",
      body: "3 tests failed in billing",
      level: "warning",
      actions: [{ kind: "open", label: "Open run", ref: "run:1" }],
      disclosureLevel: "internal",
      clippedFactCount: 2,
      contentHash: `hash-${id}`,
    },
    attemptCount: 1,
    maxAttempts: 3,
    createdAt: updatedAt - 1000,
    updatedAt,
    ...over,
  }
}

function attempt(id: string, intentId: string): NotificationDeliveryAttempt {
  return {
    id,
    intentId,
    attemptIndex: 1,
    outcome: "accepted",
    startedAt: OLD,
    finishedAt: OLD,
    createdAt: OLD,
  }
}

function timer(
  id: string,
  state: NotificationTimer["state"],
  updatedAt: number
): NotificationTimer {
  return {
    id,
    scopeKey: "scope",
    kind: "retry",
    dueAt: updatedAt,
    cancelToken: "token",
    state,
    createdAt: updatedAt,
    updatedAt,
  }
}

function member(id: string, flushedAt: number | undefined): NotificationAggregateMember {
  return {
    id,
    scopeKey: "scope",
    aggregateKey: "bucket",
    notificationId: `n-${id}`,
    joinedAt: OLD,
    bucketOpenedAt: OLD,
    ...(flushedAt !== undefined ? { flushedAt } : {}),
    createdAt: OLD,
  }
}

function publication(
  id: string,
  state: NotificationPublication["state"],
  updatedAt: number
): NotificationPublication {
  return {
    id,
    scopeKey: "scope",
    notificationId: `n-${id}`,
    targetId: "target",
    slotKey: `slot-${id}`,
    purpose: "result-summary",
    renderedRevision: 1,
    runTerminal: true,
    state,
    createdAt: updatedAt,
    updatedAt,
  }
}

const prune = () => pruneNotificationDelivery({ cutoff: CUTOFF, now: NOW })

describe("settled intents", () => {
  it("compacts an aged settled intent and deletes its attempts, keeping the dedupe key", async () => {
    const db = getDb()
    await db.notificationDeliveryIntents.put(intent("i1", "accepted", OLD))
    await db.notificationDeliveryAttempts.bulkPut([attempt("a1", "i1"), attempt("a2", "i1")])

    const report = await prune()
    expect(report).toMatchObject({ intentsCompacted: 1, attemptsDeleted: 2 })

    const row = await db.notificationDeliveryIntents.get("i1")
    expect(row).toMatchObject({
      status: "accepted",
      operationKey: "op-i1",
      targetId: "target",
      targetAddress: { kind: "connector" },
      payload: {
        level: "warning",
        disclosureLevel: "internal",
        clippedFactCount: 2,
        contentHash: "hash-i1",
      },
      compactedAt: NOW,
      // Compaction is not a lifecycle change.
      updatedAt: OLD,
    })
    expect(JSON.stringify(row)).not.toContain("3 tests failed")
    expect(JSON.stringify(row)).not.toContain("oc_room")
    expect(JSON.stringify(row)).not.toContain("Open run")
    expect(await db.notificationDeliveryAttempts.count()).toBe(0)
    // The unique key still answers "already delivered" for a re-projection.
    await expect(getIntentByOperationKey("op-i1")).resolves.toMatchObject({ id: "i1" })
  })

  it("compacts every settled status except delivery-unknown", async () => {
    const db = getDb()
    const settled = [
      "accepted",
      "rejected",
      "failed",
      "superseded",
      "cancelled",
      "expired",
    ] as const
    await db.notificationDeliveryIntents.bulkPut([
      ...settled.map((status) => intent(status, status, OLD)),
      intent("unknown", "delivery-unknown", OLD),
    ])
    await db.notificationDeliveryAttempts.put(attempt("a-unknown", "unknown"))

    expect((await prune()).intentsCompacted).toBe(settled.length)
    const unknown = await db.notificationDeliveryIntents.get("unknown")
    expect(unknown?.compactedAt).toBeUndefined()
    expect(unknown?.payload).toMatchObject({ body: "3 tests failed in billing" })
    expect(await db.notificationDeliveryAttempts.get("a-unknown")).toBeDefined()
  })

  it("leaves in-flight and young intents whole", async () => {
    const db = getDb()
    await db.notificationDeliveryIntents.bulkPut([
      intent("queued", "queued", OLD),
      intent("sending", "sending", OLD),
      intent("prepared", "prepared", OLD),
      intent("young", "accepted", YOUNG),
    ])
    await db.notificationDeliveryAttempts.put(attempt("a-young", "young"))

    expect((await prune()).intentsCompacted).toBe(0)
    for (const id of ["queued", "sending", "prepared", "young"]) {
      expect((await db.notificationDeliveryIntents.get(id))?.compactedAt).toBeUndefined()
    }
    expect(await db.notificationDeliveryAttempts.get("a-young")).toBeDefined()
  })

  it("is idempotent", async () => {
    await getDb().notificationDeliveryIntents.put(intent("i1", "failed", OLD))
    expect((await prune()).intentsCompacted).toBe(1)
    expect(await prune()).toEqual({
      intentsCompacted: 0,
      attemptsDeleted: 0,
      timersDeleted: 0,
      aggregateMembersDeleted: 0,
      publicationsDeleted: 0,
    })
  })

  it("never lets a compacted intent transition again", async () => {
    await getDb().notificationDeliveryIntents.put(intent("i1", "accepted", OLD))
    await prune()
    await expect(transitionIntent("i1", "accepted", { status: "superseded" })).resolves.toBe(
      undefined
    )
    expect((await getDb().notificationDeliveryIntents.get("i1"))?.status).toBe("accepted")
  })

  it("keeps suppress-if-unchanged working against a compacted baseline", async () => {
    const facts = [{ kind: "metric", label: "tests", value: "12 passed" }] as never
    const hash = materialHashOfFacts(facts)
    await getDb().notificationDeliveryIntents.put(
      intent("i1", "accepted", OLD, {
        payload: {
          title: "t",
          body: "b",
          level: "info",
          disclosureLevel: "public",
          clippedFactCount: 0,
          contentHash: hash,
        },
      })
    )
    await prune()
    const baseline = (await getDb().notificationDeliveryIntents.get("i1"))!
    expect(baseline.compactedAt).toBe(NOW)
    expect(judgeMateriality({ candidateFacts: facts, baselines: [baseline] })).toMatchObject({
      material: false,
      reason: "unchanged",
    })
  })
})

describe("settled bookkeeping", () => {
  it("deletes aged fired, cancelled and expired timers, and keeps armed or young ones", async () => {
    const db = getDb()
    await db.notificationTimers.bulkPut([
      timer("fired", "fired", OLD),
      timer("cancelled", "cancelled", OLD),
      timer("expired", "expired", OLD),
      timer("armed", "armed", OLD),
      timer("young", "fired", YOUNG),
    ])
    expect((await prune()).timersDeleted).toBe(3)
    expect((await db.notificationTimers.toCollection().primaryKeys()).sort()).toEqual([
      "armed",
      "young",
    ])
  })

  it("deletes aged flushed digest members and keeps unflushed or young ones", async () => {
    const db = getDb()
    await db.notificationAggregateMembers.bulkPut([
      member("flushed", OLD),
      member("pending", undefined),
      member("young", YOUNG),
    ])
    expect((await prune()).aggregateMembersDeleted).toBe(1)
    expect((await db.notificationAggregateMembers.toCollection().primaryKeys()).sort()).toEqual([
      "pending",
      "young",
    ])
  })

  it("deletes aged settled publications no whole intent points at", async () => {
    const db = getDb()
    await db.notificationPublications.bulkPut([
      publication("closed", "closed", OLD),
      publication("superseded", "superseded", OLD),
      publication("open", "open", OLD),
      publication("young", "closed", YOUNG),
      publication("held", "closed", OLD),
      publication("history", "closed", OLD),
    ])
    await db.notificationDeliveryIntents.bulkPut([
      // A whole intent may still fold a receipt onto its publication.
      intent("live", "queued", OLD, { publicationId: "held" }),
      // Compacted in the same sweep: history, nothing left to fold.
      intent("settled", "accepted", OLD, { publicationId: "history" }),
    ])

    expect((await prune()).publicationsDeleted).toBe(3)
    expect((await db.notificationPublications.toCollection().primaryKeys()).sort()).toEqual([
      "held",
      "open",
      "young",
    ])
  })
})

describe("publication retention atomicity", () => {
  it("rolls back publication deletions if the publication transaction fails", async () => {
    const db = getDb()
    await db.notificationPublications.bulkPut([
      publication("rollback-a", "closed", OLD),
      publication("rollback-b", "superseded", OLD),
    ])
    const original = db.notificationPublications.bulkDelete.bind(db.notificationPublications)
    const deletion = jest
      .spyOn(db.notificationPublications, "bulkDelete")
      .mockImplementationOnce((keys) =>
        original(keys).then(() => {
          throw new Error("injected publication failure")
        })
      )
    try {
      await expect(prune()).rejects.toThrow("injected publication failure")
      expect(await db.notificationPublications.toCollection().primaryKeys()).toEqual([
        "rollback-a",
        "rollback-b",
      ])
    } finally {
      deletion.mockRestore()
    }
    expect((await prune()).publicationsDeleted).toBe(2)
  })
})
