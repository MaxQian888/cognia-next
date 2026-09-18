/**
 * Tests for lib/db/notification-delivery.ts — durable delivery intents and
 * the append-only attempt log. Covers operationKey idempotency, the status
 * CAS, the supersede sweep, cancellation, the attempt-index allocation, and
 * the sendable / stale-send scans the delivery runtime runs.
 *
 * Dexie runs on fake-indexeddb via createDbTestFixture (jsdom project).
 */

import { createDbTestFixture } from "./test-fixture"
import {
  persistDeliveryIntent,
  getIntentByOperationKey,
  getLiveIntentForSlot,
  transitionIntent,
  supersedeSlotIntents,
  cancelIntent,
  appendDeliveryAttempt,
  listAttemptsForIntent,
  listIntentsForLogicalKey,
  listIntentsForRun,
  listSendableIntents,
  listStaleSendingIntents,
} from "./notification-delivery"
import type { NotificationDeliveryIntent } from "@/types/notifications/delivery"
import type { NotificationScope } from "@/types/notifications/scope"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const scope: NotificationScope = {
  namespaceId: "n",
  accountId: "a",
  authorityHostId: "h",
  workspaceId: "w",
}
const SCOPE_KEY = "scope-A"

function intentInput(
  over: Partial<NotificationDeliveryIntent> = {}
): Omit<NotificationDeliveryIntent, "id" | "createdAt" | "updatedAt" | "attemptCount"> {
  return {
    scopeKey: SCOPE_KEY,
    scope,
    operationKey: over.operationKey ?? `op-${Math.random().toString(36).slice(2)}`,
    targetId: over.targetId ?? "t1",
    targetAddress: over.targetAddress ?? {
      kind: "feishu-webhook",
      endpointSecretRef: "ref",
      region: "feishu",
    },
    targetVersion: 1,
    purpose: over.purpose ?? "terminal-state",
    category: over.category ?? "run.terminal",
    status: over.status ?? "queued",
    payload: over.payload ?? {
      title: "T",
      body: "B",
      level: "info",
      disclosureLevel: "internal",
      clippedFactCount: 0,
      contentHash: "h",
    },
    maxAttempts: 5,
    ...(over.slotKey ? { slotKey: over.slotKey } : {}),
    ...(over.logicalKey ? { logicalKey: over.logicalKey } : {}),
    ...(over.notificationId ? { notificationId: over.notificationId } : {}),
    ...(over.outboundJobId ? { outboundJobId: over.outboundJobId } : {}),
    ...(over.notBefore !== undefined ? { notBefore: over.notBefore } : {}),
    ...(over.expiresAt !== undefined ? { expiresAt: over.expiresAt } : {}),
    ...(over.nextAttemptAt !== undefined ? { nextAttemptAt: over.nextAttemptAt } : {}),
    ...(over.lastAttemptAt !== undefined ? { lastAttemptAt: over.lastAttemptAt } : {}),
  }
}

describe("persistDeliveryIntent + getIntentByOperationKey", () => {
  it("persists an intent retrievable by operationKey", async () => {
    const row = await persistDeliveryIntent(intentInput({ operationKey: "op-1" }))
    const found = await getIntentByOperationKey("op-1")
    expect(found?.id).toBe(row.id)
    expect(row.attemptCount).toBe(0)
  })

  it("rejects a second persist of the same operationKey (idempotent re-entry)", async () => {
    await persistDeliveryIntent(intentInput({ operationKey: "op-dup" }))
    await expect(persistDeliveryIntent(intentInput({ operationKey: "op-dup" }))).rejects.toThrow()
  })
})

describe("getLiveIntentForSlot", () => {
  it("returns the live intent, ignoring terminal ones", async () => {
    await persistDeliveryIntent(
      intentInput({ slotKey: "s1", status: "accepted", operationKey: "a" })
    )
    const live = await persistDeliveryIntent(
      intentInput({ slotKey: "s1", status: "queued", operationKey: "b" })
    )
    const found = await getLiveIntentForSlot("s1")
    expect(found?.id).toBe(live.id)
  })

  it("returns undefined when every intent for the slot is terminal", async () => {
    await persistDeliveryIntent(intentInput({ slotKey: "s2", status: "failed" }))
    expect(await getLiveIntentForSlot("s2")).toBeUndefined()
  })
})

describe("transitionIntent", () => {
  it("transitions when the current status is allowed", async () => {
    const row = await persistDeliveryIntent(intentInput({ status: "queued" }))
    const next = await transitionIntent(row.id, "queued", { status: "sending" })
    expect(next?.status).toBe("sending")
  })

  it("refuses when the current status is not in the allowed set", async () => {
    const row = await persistDeliveryIntent(intentInput({ status: "accepted" }))
    const blocked = await transitionIntent(row.id, "queued", { status: "sending" })
    expect(blocked).toBeUndefined()
  })
})

describe("supersedeSlotIntents", () => {
  it("closes every live intent for the slot except the named one", async () => {
    await persistDeliveryIntent(
      intentInput({ slotKey: "sx", status: "queued", operationKey: "o1" })
    )
    await persistDeliveryIntent(
      intentInput({ slotKey: "sx", status: "prepared", operationKey: "o2" })
    )
    const keep = await persistDeliveryIntent(
      intentInput({ slotKey: "sx", status: "queued", operationKey: "o3" })
    )
    await supersedeSlotIntents("sx", keep.id)
    const fa = await getIntentByOperationKey("o1")
    const fb = await getIntentByOperationKey("o2")
    const fc = await getIntentByOperationKey("o3")
    expect(fa?.status).toBe("superseded")
    expect(fb?.status).toBe("superseded")
    expect(fc?.status).toBe("queued") // the survivor
  })
})

describe("cancelIntent", () => {
  it("cancels a queued intent", async () => {
    const row = await persistDeliveryIntent(intentInput({ status: "queued" }))
    const cancelled = await cancelIntent(row.id)
    expect(cancelled?.status).toBe("cancelled")
  })

  it("does NOT cancel an already-accepted intent", async () => {
    const row = await persistDeliveryIntent(intentInput({ status: "accepted" }))
    expect(await cancelIntent(row.id)).toBeUndefined()
  })
})

describe("appendDeliveryAttempt", () => {
  it("appends attempt 1 and bumps the intent's attemptCount", async () => {
    const intent = await persistDeliveryIntent(intentInput())
    const attempt = await appendDeliveryAttempt({
      intentId: intent.id,
      outcome: "accepted",
      receipt: { platformMessageId: "m1" },
      startedAt: Date.now(),
    })
    expect(attempt.attemptIndex).toBe(1)
    const reloaded = await getIntentByOperationKey(intent.operationKey)
    expect(reloaded?.attemptCount).toBe(1)
    expect(reloaded?.lastAttemptAt).toBeGreaterThan(0)
  })

  it("allocates monotonically increasing attemptIndex", async () => {
    const intent = await persistDeliveryIntent(intentInput())
    await appendDeliveryAttempt({ intentId: intent.id, outcome: "network-error", startedAt: 1 })
    const second = await appendDeliveryAttempt({
      intentId: intent.id,
      outcome: "accepted",
      startedAt: 2,
    })
    expect(second.attemptIndex).toBe(2)
  })

  it("throws when the intent does not exist", async () => {
    await expect(
      appendDeliveryAttempt({ intentId: "nope", outcome: "accepted", startedAt: 1 })
    ).rejects.toThrow("intent-not-found")
  })
})

describe("listAttemptsForIntent", () => {
  it("returns the attempts in send order", async () => {
    const intent = await persistDeliveryIntent(intentInput())
    await appendDeliveryAttempt({ intentId: intent.id, outcome: "network-error", startedAt: 1 })
    await appendDeliveryAttempt({ intentId: intent.id, outcome: "accepted", startedAt: 2 })
    const attempts = await listAttemptsForIntent(intent.id)
    expect(attempts.map((a) => a.attemptIndex)).toEqual([1, 2])
    expect(attempts[0].outcome).toBe("network-error")
    expect(attempts[1].outcome).toBe("accepted")
  })
})

describe("listIntentsForLogicalKey", () => {
  it("returns every intent sharing the fact's logicalKey", async () => {
    await persistDeliveryIntent(intentInput({ logicalKey: "LK", operationKey: "x1" }))
    await persistDeliveryIntent(intentInput({ logicalKey: "LK", operationKey: "x2" }))
    await persistDeliveryIntent(intentInput({ logicalKey: "OTHER", operationKey: "x3" }))
    const rows = await listIntentsForLogicalKey("LK")
    expect(rows).toHaveLength(2)
  })
})

describe("listIntentsForRun", () => {
  it("returns every intent whose logicalKey is under the run prefix", async () => {
    await persistDeliveryIntent(intentInput({ logicalKey: "run:r1:a", operationKey: "x1" }))
    await persistDeliveryIntent(intentInput({ logicalKey: "run:r1:b", operationKey: "x2" }))
    await persistDeliveryIntent(intentInput({ logicalKey: "run:r2:a", operationKey: "x3" }))
    await persistDeliveryIntent(intentInput({ logicalKey: "other:r1:a", operationKey: "x4" }))
    const rows = await listIntentsForRun("r1")
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.logicalKey?.startsWith("run:r1:"))).toBe(true)
  })

  it("does not match a run id that is only a prefix of another", async () => {
    await persistDeliveryIntent(intentInput({ logicalKey: "run:r12:a", operationKey: "x1" }))
    const rows = await listIntentsForRun("r1")
    expect(rows).toHaveLength(0)
  })
})

describe("listSendableIntents", () => {
  it("returns queued/prepared intents whose gates have passed", async () => {
    const sendable = await persistDeliveryIntent(intentInput({ status: "queued" }))
    const rows = await listSendableIntents()
    expect(rows.map((r) => r.id)).toContain(sendable.id)
  })

  it("excludes a notBefore-deferred intent", async () => {
    await persistDeliveryIntent(intentInput({ status: "queued", notBefore: Date.now() + 60_000 }))
    const rows = await listSendableIntents()
    expect(rows).toHaveLength(0)
  })

  it("excludes an expired intent", async () => {
    await persistDeliveryIntent(intentInput({ status: "queued", expiresAt: Date.now() - 1 }))
    const rows = await listSendableIntents()
    expect(rows).toHaveLength(0)
  })
})

describe("listStaleSendingIntents", () => {
  it("returns a sending intent whose last attempt is older than the cutoff", async () => {
    const stale = await persistDeliveryIntent(
      intentInput({ status: "sending", lastAttemptAt: Date.now() - 120_000 })
    )
    const rows = await listStaleSendingIntents(Date.now() - 60_000)
    expect(rows.map((r) => r.id)).toContain(stale.id)
  })

  it("excludes a recently-active sending intent", async () => {
    await persistDeliveryIntent(intentInput({ status: "sending", lastAttemptAt: Date.now() }))
    const rows = await listStaleSendingIntents(Date.now() - 60_000)
    expect(rows).toHaveLength(0)
  })
})
