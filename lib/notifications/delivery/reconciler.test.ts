/**
 * Tests for lib/notifications/delivery/reconciler.ts — the compensatory sweep.
 * Covers the receipt-drift fold (terminal job → intent), stale-send recovery
 * (a crashed `sending` claim reconciles from its job's evidence, never a
 * blind re-send), the due-timer fire (a quiet-release re-queues the deferred
 * intent), and the scope-prefix scoping of the sweep.
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { persistDeliveryIntent, getDeliveryIntent } from "@/lib/db/notification-delivery"
import { armNotificationTimer } from "@/lib/db/notification-timers"
import { reconcileNotifications } from "./reconciler"
import type { NotificationPolicyContext } from "@/types/notifications/decision"
import type { NotificationRenderedPayload } from "@/types/notifications/result"
import type { NotificationScope } from "@/types/notifications/scope"
import type { OutboundJobRow } from "@/lib/db/connector-types"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => await dbFixture.restore())
afterAll(async () => await dbFixture.dispose())

const scope: NotificationScope = { namespaceId: "ns", accountId: "a", authorityHostId: "h" }
const SCOPE_KEY = "scope-A"
const OTHER_SCOPE = "scope-B"

const policy: NotificationPolicyContext = {
  policyVersion: 1,
  timezone: "UTC",
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  quietHoursAllowCritical: false,
  osThreshold: "info",
  pushThreshold: "info",
}

const payload: NotificationRenderedPayload = {
  title: "T",
  body: "B",
  level: "info",
  disclosureLevel: "public",
  clippedFactCount: 0,
  contentHash: "h",
}

function job(over: Partial<OutboundJobRow> = {}): OutboundJobRow {
  return {
    id: "job-1",
    adapterId: "a",
    conversationKey: "c1",
    request: {
      conversationRef: { platform: "feishu", adapterId: "a" },
      segments: [],
      metadata: { idempotencyKey: "ik" },
    },
    status: "sent",
    attempts: 1,
    createdAt: 0,
    nextAttemptAt: 0,
    idempotencyKey: "ik",
    source: "notification",
    notificationOperationKey: "op-1",
    ...over,
  }
}

async function sendingIntent(over: { outboundJobId?: string; lastAttemptAt?: number } = {}) {
  return persistDeliveryIntent({
    scopeKey: SCOPE_KEY,
    scope,
    notificationId: "n1",
    operationKey: "op-1",
    targetId: "t1",
    targetAddress: { kind: "connector", adapterId: "a", deliveryTarget: {} as never },
    targetVersion: 1,
    purpose: "terminal-state",
    category: "run.terminal",
    status: "sending",
    payload,
    attemptCount: 1,
    maxAttempts: 5,
    lastAttemptAt: over.lastAttemptAt ?? 0,
    ...(over.outboundJobId ? { outboundJobId: over.outboundJobId } : {}),
  })
}

describe("reconcileNotifications — stale sends", () => {
  it("recovers a crashed `sending` claim from its job's requeued evidence", async () => {
    // The runner crashed mid-send and the job got requeued `pending` — the
    // stale intent mirrors back to `queued` rather than being blindly re-sent.
    const intent = await sendingIntent({ outboundJobId: "job-1", lastAttemptAt: 0 })
    await getDb().outboundQueue.put(job({ status: "pending" }))
    const result = await reconcileNotifications({
      scopeKey: SCOPE_KEY,
      policy,
      leaseOwner: "host-1",
      now: Date.now(),
    })
    expect(result.staleSendsRecovered).toBe(1)
    expect((await getDeliveryIntent(intent.id))?.status).toBe("queued")
  })

  it("leaves a fresh `sending` claim alone (inside grace)", async () => {
    await sendingIntent({ outboundJobId: "job-1", lastAttemptAt: Date.now() })
    await getDb().outboundQueue.put(job({ status: "sent" }))
    const result = await reconcileNotifications({
      scopeKey: SCOPE_KEY,
      policy,
      leaseOwner: "host-1",
      now: Date.now(),
    })
    expect(result.staleSendsRecovered).toBe(0)
  })

  it("recovers a stale `sending` webhook intent to delivery-unknown (no blind re-send)", async () => {
    // No outboundJobId — a webhook intent. A stale `sending` means a crash
    // between the send and the attempt-append: the outcome is genuinely
    // uncertain (the platform may already have it), so per the no-blind-retry
    // rule it lands `delivery-unknown`, never re-queued.
    const intent = await sendingIntent({ lastAttemptAt: 0 })
    const result = await reconcileNotifications({
      scopeKey: SCOPE_KEY,
      policy,
      leaseOwner: "host-1",
      now: Date.now(),
    })
    expect(result.staleSendsRecovered).toBe(1)
    expect((await getDeliveryIntent(intent.id))?.status).toBe("delivery-unknown")
  })

  it("leaves a stale `sending` intent sending when its job has no receipt to project", async () => {
    const intent = await sendingIntent({ outboundJobId: "job-1", lastAttemptAt: 0 })
    await getDb().outboundQueue.put(job({ status: "sending" }))
    const result = await reconcileNotifications({
      scopeKey: SCOPE_KEY,
      policy,
      leaseOwner: "host-1",
      now: Date.now(),
    })
    expect(result.staleSendsRecovered).toBe(0)
    expect((await getDeliveryIntent(intent.id))?.status).toBe("sending")
  })

  it("tombstones a claimed work row whose run vanished", async () => {
    // Seed a due projection-work row pointing at a run that doesn't exist —
    // the coordinator's vanished-run path advances it to `done` (nothing to
    // project), not an error.
    const db = getDb()
    await db.notificationProjectionWork.put({
      id: "w1",
      subjectKey: "run:gone",
      scopeKey: SCOPE_KEY,
      runId: "gone",
      desiredRunSeq: 5,
      desiredResultRevision: 0,
      processedRunSeq: 0,
      processedResultRevision: 0,
      generation: 1,
      state: "pending",
      createdAt: 0,
      updatedAt: 0,
    } as never)
    const result = await reconcileNotifications({
      scopeKey: SCOPE_KEY,
      policy,
      leaseOwner: "host-1",
      now: Date.now(),
    })
    expect(result.claimedWork).toBe(1)
    const work = await db.notificationProjectionWork.where("subjectKey").equals("run:gone").first()
    expect(work?.state).toBe("done")
  })
})

describe("reconcileNotifications — receipt drift", () => {
  it("projects a terminal notification job onto its intent", async () => {
    const intent = await sendingIntent({ outboundJobId: "job-1" })
    await getDb().outboundQueue.put(job({ status: "deadlettered", lastErrorCode: "socket_reset" }))
    const result = await reconcileNotifications({
      scopeKey: SCOPE_KEY,
      policy,
      leaseOwner: "host-1",
      now: Date.now(),
    })
    // Receipt fold + stale-send recovery both fire on the same job — at least
    // one path lands the intent terminal.
    const stored = await getDeliveryIntent(intent.id)
    expect(stored?.status).toBe("failed")
    expect(result.projectedReceipts + result.staleSendsRecovered).toBeGreaterThanOrEqual(1)
  })
})

describe("reconcileNotifications — due timers", () => {
  it("fires a due quiet-release timer, re-queuing the deferred intent", async () => {
    const intent = await persistDeliveryIntent({
      scopeKey: SCOPE_KEY,
      scope,
      notificationId: "n1",
      operationKey: "op-q",
      targetId: "t1",
      targetAddress: { kind: "connector", adapterId: "a", deliveryTarget: {} as never },
      targetVersion: 1,
      purpose: "terminal-state",
      category: "run.terminal",
      status: "queued",
      payload,
      attemptCount: 0,
      maxAttempts: 5,
      notBefore: Date.now() + 60_000, // deferred
    })
    await armNotificationTimer({
      scopeKey: SCOPE_KEY,
      kind: "quiet-release",
      intentId: intent.id,
      dueAt: Date.now() - 1000, // already due
    })
    const result = await reconcileNotifications({
      scopeKey: SCOPE_KEY,
      policy,
      leaseOwner: "host-1",
      now: Date.now(),
    })
    expect(result.timersFired).toBe(1)
    const stored = await getDeliveryIntent(intent.id)
    expect(stored?.notBefore).toBeUndefined() // released
  })

  it("does NOT fire a timer outside this reconciler's scope prefix", async () => {
    const timer = await armNotificationTimer({
      scopeKey: OTHER_SCOPE,
      kind: "quiet-release",
      dueAt: Date.now() - 1000,
    })
    const result = await reconcileNotifications({
      scopeKey: SCOPE_KEY,
      policy,
      leaseOwner: "host-1",
      now: Date.now(),
    })
    expect(result.timersFired).toBe(0)
    expect((await getDb().notificationTimers.get(timer.id))?.state).toBe("armed") // untouched
  })

  it("fires a due quiet-release timer with no intent — the release is a no-op", async () => {
    await armNotificationTimer({
      scopeKey: SCOPE_KEY,
      kind: "quiet-release",
      dueAt: Date.now() - 1000, // no intentId — nothing to release
    })
    const result = await reconcileNotifications({
      scopeKey: SCOPE_KEY,
      policy,
      leaseOwner: "host-1",
      now: Date.now(),
    })
    expect(result.timersFired).toBe(1)
  })

  it.each([
    "digest-flush",
    "escalation",
    "retry",
    "approval-expiry",
    "materiality-recheck",
  ] as const)("fires a due %s timer — its effect is consumed on the next pass", async (kind) => {
    const timer = await armNotificationTimer({
      scopeKey: SCOPE_KEY,
      kind,
      dueAt: Date.now() - 1000,
    })
    const result = await reconcileNotifications({
      scopeKey: SCOPE_KEY,
      policy,
      leaseOwner: "host-1",
      now: Date.now(),
    })
    expect(result.timersFired).toBe(1)
    expect((await getDb().notificationTimers.get(timer.id))?.state).toBe("fired")
  })
})
