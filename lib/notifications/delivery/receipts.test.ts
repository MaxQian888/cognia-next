/**
 * Tests for lib/notifications/delivery/receipts.ts — the projector that folds
 * an outbound job's outcome back onto its notification intent + an append-only
 * attempt. Covers the error→outcome classification, the terminal/non-terminal
 * projection split, idempotent re-sweeps, the publication receipt fold, and
 * the reconcile pass.
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  persistDeliveryIntent,
  getDeliveryIntent,
  getIntentByOperationKey,
} from "@/lib/db/notification-delivery"
import { getOrCreatePublication, getPublication } from "@/lib/db/notification-publications"
import {
  classifyOutboundError,
  projectOutboundJobReceipt,
  reconcileNotificationReceipts,
} from "./receipts"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import type { NotificationRenderedPayload } from "@/types/notifications/result"
import type { NotificationScope } from "@/types/notifications/scope"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => await dbFixture.restore())
afterAll(async () => await dbFixture.dispose())

const scope: NotificationScope = { namespaceId: "ns", accountId: "a", authorityHostId: "h" }
const SCOPE_KEY = "scope-A"

const payload: NotificationRenderedPayload = {
  title: "T",
  body: "B",
  level: "info",
  disclosureLevel: "public",
  clippedFactCount: 0,
  contentHash: "hash-1",
}

async function seedIntent(over: { status?: string; publicationId?: string } = {}) {
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
    status: (over.status ?? "queued") as never,
    payload,
    attemptCount: 0,
    maxAttempts: 5,
    ...(over.publicationId ? { publicationId: over.publicationId } : {}),
  })
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

describe("classifyOutboundError", () => {
  it("maps known error codes to outcomes", () => {
    expect(classifyOutboundError(job({ lastErrorCode: "RATE_LIMIT_429" }))).toBe("rate-limited")
    expect(classifyOutboundError(job({ lastErrorCode: "auth_token_expired" }))).toBe("auth-failed")
    expect(classifyOutboundError(job({ lastErrorCode: "target_not_found" }))).toBe("invalid-target")
    expect(classifyOutboundError(job({ lastErrorCode: "bad_request_payload" }))).toBe(
      "content-rejected"
    )
    expect(classifyOutboundError(job({ lastErrorCode: "send_timeout" }))).toBe("timeout-unknown")
    expect(classifyOutboundError(job({ lastErrorCode: "socket_reset" }))).toBe("network-error")
    expect(classifyOutboundError(job({ lastErrorCode: undefined }))).toBe("network-error")
  })
})

describe("projectOutboundJobReceipt", () => {
  it("ignores a job with no notificationOperationKey", async () => {
    expect(await projectOutboundJobReceipt(job({ notificationOperationKey: undefined }))).toBeNull()
  })

  it("ignores a job whose intent doesn't exist", async () => {
    expect(await projectOutboundJobReceipt(job({ notificationOperationKey: "nope" }))).toBeNull()
  })

  it("projects a sent job → accepted intent + one attempt", async () => {
    const intent = await seedIntent()
    const applied = await projectOutboundJobReceipt(job({ platformMessageId: "om_9" }))
    expect(applied).toEqual({ intentId: intent.id, status: "accepted" })
    const stored = await getDeliveryIntent(intent.id)
    expect(stored?.status).toBe("accepted")
    const attempts = await getDb()
      .notificationDeliveryAttempts.where("intentId")
      .equals(intent.id)
      .toArray()
    expect(attempts).toHaveLength(1)
    expect(attempts[0].outcome).toBe("accepted")
    expect(attempts[0].receipt?.platformMessageId).toBe("om_9")
  })

  it("projects a deadlettered job → failed intent with the classified outcome", async () => {
    const intent = await seedIntent()
    const applied = await projectOutboundJobReceipt(
      job({ status: "deadlettered", lastErrorCode: "socket_reset" })
    )
    expect(applied?.status).toBe("failed")
    const attempts = await getDb()
      .notificationDeliveryAttempts.where("intentId")
      .equals(intent.id)
      .toArray()
    expect(attempts[0].outcome).toBe("network-error")
  })

  it("projects a deadlettered auth error → rejected intent", async () => {
    await seedIntent()
    const applied = await projectOutboundJobReceipt(
      job({ status: "deadlettered", lastErrorCode: "auth_token_expired" })
    )
    expect(applied?.status).toBe("rejected")
  })

  it("projects delivery_unknown → delivery-unknown intent", async () => {
    await seedIntent()
    const applied = await projectOutboundJobReceipt(job({ status: "delivery_unknown" }))
    expect(applied?.status).toBe("delivery-unknown")
  })

  it("is idempotent — a terminal intent is not re-projected", async () => {
    const intent = await seedIntent()
    await projectOutboundJobReceipt(job())
    expect(await projectOutboundJobReceipt(job())).toBeNull() // already terminal
    const attempts = await getDb()
      .notificationDeliveryAttempts.where("intentId")
      .equals(intent.id)
      .toArray()
    expect(attempts).toHaveLength(1)
  })

  it("mirrors a non-terminal job status without an attempt", async () => {
    const intent = await seedIntent()
    const applied = await projectOutboundJobReceipt(job({ status: "sending" }))
    expect(applied?.status).toBe("sending")
    const attempts = await getDb()
      .notificationDeliveryAttempts.where("intentId")
      .equals(intent.id)
      .toArray()
    expect(attempts).toHaveLength(0)
  })

  it("folds the platform receipt onto the publication on accept", async () => {
    const pub = await getOrCreatePublication({
      scopeKey: SCOPE_KEY,
      notificationId: "n1",
      targetId: "t1",
      slotKey: "slot-1",
      purpose: "terminal-state",
      runTerminal: false,
      state: "open",
    })
    await seedIntent({ publicationId: pub.id })
    await projectOutboundJobReceipt(job({ platformMessageId: "om_42" }))
    const stored = await getPublication(pub.id)
    expect(stored?.platformMessageId).toBe("om_42")
    expect(stored?.acceptedContentHash).toBe("hash-1")
  })
})

describe("reconcileNotificationReceipts", () => {
  it("projects every terminal notification-sourced job", async () => {
    await seedIntent()
    await getDb().outboundQueue.put(job({ status: "sent", platformMessageId: "om_1" }))
    await getDb().outboundQueue.put(
      job({
        id: "job-2",
        status: "deadlettered",
        lastErrorCode: "socket_reset",
        notificationOperationKey: "op-2",
      })
    )
    // op-2 has no intent → skipped; op-1 projects.
    const result = await reconcileNotificationReceipts()
    expect(result.scanned).toBe(2)
    expect(result.projected).toBe(1)
    const intent = await getIntentByOperationKey("op-1")
    expect(intent?.status).toBe("accepted")
  })

  it("ignores non-notification jobs", async () => {
    await getDb().outboundQueue.put(job({ status: "sent", notificationOperationKey: undefined }))
    const result = await reconcileNotificationReceipts()
    expect(result.projected).toBe(0)
  })
})
