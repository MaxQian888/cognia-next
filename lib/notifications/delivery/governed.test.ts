/**
 * Tests for lib/notifications/delivery/governed.ts — the transaction-safe
 * delivery split. Covers the prepare phase's target/subscription/consent/PII
 * validation + request build, and the commit phase's version revalidation,
 * per-conversation orderSeq allocation, outbound-job + intent atomicity, and
 * the idempotent operation-key re-entry.
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { upsertNotificationTarget } from "@/lib/db/notification-targets"
import { upsertNotificationSubscription } from "@/lib/db/notification-subscriptions"
import { getDeliveryIntent } from "@/lib/db/notification-delivery"
import {
  prepareGovernedNotificationDelivery,
  persistGovernedNotificationInsideTransaction,
} from "./governed"
import type { NotificationRenderedPayload } from "@/types/notifications/result"
import type { NotificationScope } from "@/types/notifications/scope"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => await dbFixture.restore())
afterAll(async () => await dbFixture.dispose())

const scope: NotificationScope = {
  namespaceId: "ns",
  accountId: "a",
  authorityHostId: "h",
  workspaceId: "ws",
}

const payload: NotificationRenderedPayload = {
  title: "T",
  body: "B",
  level: "info",
  disclosureLevel: "public",
  clippedFactCount: 0,
  contentHash: "hash-1",
}

async function connectorTarget(
  over: { enabled?: boolean; consent?: "proactive" | "origin-reply" } = {}
) {
  return upsertNotificationTarget({
    scope,
    label: "conn",
    address: {
      kind: "connector",
      adapterId: "feishu",
      deliveryTarget: {
        conversationRef: { platform: "feishu", adapterId: "feishu" },
        address: { conversationKey: "ck", platform: "feishu", adapterId: "feishu" } as never,
      } as never,
      conversationKey: "ck",
    },
    enabled: over.enabled ?? true,
    consent: { mode: over.consent ?? "proactive", grantRef: "g", grantedBy: "a", grantedAt: 0 },
    disclosureProfileId: "public",
    locale: "en",
    timezone: "UTC",
  })
}

async function scopeSub(targetIds: string[], enabled = true) {
  return upsertNotificationSubscription({
    scope,
    principalId: "a",
    binding: { kind: "scope" },
    targetIds,
    maxDisclosureProfileId: "public",
    minLevel: "info",
    enabled,
    createdBy: "a",
  })
}

const prep = (targetId: string, over: Record<string, unknown> = {}) =>
  prepareGovernedNotificationDelivery({
    targetId,
    payload,
    purpose: "terminal-state",
    category: "run.terminal",
    operationKey: "op-1",
    ...over,
  })

describe("prepareGovernedNotificationDelivery", () => {
  it("freezes the request, scope, target version, and payload", async () => {
    const t = await connectorTarget()
    const p = await prep(t.id, { slotKey: "s1", subscriptionId: undefined })
    expect(p.operationKey).toBe("op-1")
    expect(p.expectedTargetVersion).toBe(t.version)
    expect(p.intent.targetVersion).toBe(t.version)
    expect(p.intent.scopeKey).toContain("ns")
    expect(p.intent.payload.clippedFactCount).toBe(0)
    expect(p.request.metadata.idempotencyKey).toBe("op-1")
    expect(p.conversationKey).toBe("ck")
  })

  it("rejects a missing target", async () => {
    await expect(prep("nope")).rejects.toMatchObject({ code: "target-missing" })
  })

  it("rejects a disabled target", async () => {
    const t = await connectorTarget({ enabled: false })
    await expect(prep(t.id)).rejects.toMatchObject({ code: "target-disabled" })
  })

  it("rejects a deleted target", async () => {
    const t = await connectorTarget()
    await getDb().notificationTargets.update(t.id, { deletedAt: Date.now() })
    await expect(prep(t.id)).rejects.toMatchObject({ code: "target-deleted" })
  })

  it("rejects a non-approval send to an origin-reply-consent target", async () => {
    const t = await connectorTarget({ consent: "origin-reply" })
    await expect(prep(t.id, { purpose: "terminal-state" })).rejects.toMatchObject({
      code: "consent-not-granted",
    })
  })

  it("permits an approval-request to an origin-reply-consent target", async () => {
    const t = await connectorTarget({ consent: "origin-reply" })
    const p = await prep(t.id, { purpose: "approval-request" })
    expect(p.intent.purpose).toBe("approval-request")
  })

  it("rejects a webhook target (it does not ride the governed queue)", async () => {
    const t = await upsertNotificationTarget({
      scope,
      label: "wh",
      address: { kind: "feishu-webhook", endpointSecretRef: "svc:acct", region: "feishu" },
      enabled: true,
      consent: { mode: "proactive", grantRef: "g", grantedBy: "a", grantedAt: 0 },
      disclosureProfileId: "public",
      locale: "en",
      timezone: "UTC",
    })
    await expect(prep(t.id)).rejects.toMatchObject({ code: "target-missing" })
  })

  it("rejects a subscription that doesn't bind the target", async () => {
    const t = await connectorTarget()
    const other = await connectorTarget()
    const s = await scopeSub([other.id]) // subscribes a DIFFERENT target
    await expect(prep(t.id, { subscriptionId: s.id })).rejects.toMatchObject({
      code: "consent-not-granted",
    })
  })

  it("freezes the subscription version when bound", async () => {
    const t = await connectorTarget()
    const s = await scopeSub([t.id])
    const p = await prep(t.id, { subscriptionId: s.id })
    expect(p.expectedSubscriptionVersion).toBe(s.version)
    expect(p.intent.subscriptionVersion).toBe(s.version)
  })

  it("fails closed on PII (the gate override)", async () => {
    const t = await connectorTarget()
    await expect(prep(t.id, { piiGate: () => false })).rejects.toMatchObject({
      code: "pii-rejected",
    })
  })
})

describe("persistGovernedNotificationInsideTransaction", () => {
  async function commit(p: Awaited<ReturnType<typeof prep>>) {
    const db = getDb()
    return db.transaction(
      "rw",
      [
        db.notificationDeliveryIntents,
        db.notificationTargets,
        db.notificationSubscriptions,
        db.outboundQueue,
      ],
      async () => persistGovernedNotificationInsideTransaction(db, p)
    )
  }

  it("commits the outbound job + intent atomically", async () => {
    const t = await connectorTarget()
    const p = await prep(t.id)
    const { intentId, outboundJobId } = await commit(p)
    const intent = await getDeliveryIntent(intentId)
    const job = await getDb().outboundQueue.get(outboundJobId)
    expect(intent?.status).toBe("queued")
    expect(intent?.outboundJobId).toBe(outboundJobId)
    expect(job?.notificationOperationKey).toBe("op-1")
    expect(job?.source).toBe("notification")
    expect(job?.orderSeq).toBe(1)
  })

  it("is idempotent — re-committing the same operationKey returns the existing intent", async () => {
    const t = await connectorTarget()
    const p = await prep(t.id)
    const a = await commit(p)
    const b = await commit(p)
    expect(b.intentId).toBe(a.intentId)
    expect(await getDb().notificationDeliveryIntents.count()).toBe(1)
    expect(await getDb().outboundQueue.count()).toBe(1)
  })

  it("refuses a commit when the target version moved since prepare", async () => {
    const t = await connectorTarget()
    const p = await prep(t.id)
    await upsertNotificationTarget({ ...t, id: t.id }) // bumps version
    await expect(commit(p)).rejects.toMatchObject({ code: "target-version-moved" })
    // Nothing persisted — the send didn't go out to a stale address.
    expect(await getDb().outboundQueue.count()).toBe(0)
  })

  it("refuses a commit when the subscription version moved", async () => {
    const t = await connectorTarget()
    const s = await scopeSub([t.id])
    const p = await prep(t.id, { subscriptionId: s.id })
    await upsertNotificationSubscription({ ...s, id: s.id }) // bumps version
    await expect(commit(p)).rejects.toMatchObject({ code: "subscription-version-moved" })
  })

  it("allocates a monotonic orderSeq per conversation", async () => {
    const t = await connectorTarget()
    const a = await commit(await prep(t.id, { operationKey: "op-a" }))
    const b = await commit(await prep(t.id, { operationKey: "op-b" }))
    const [ja, jb] = await Promise.all([
      getDb().outboundQueue.get(a.outboundJobId),
      getDb().outboundQueue.get(b.outboundJobId),
    ])
    expect(ja?.orderSeq).toBe(1)
    expect(jb?.orderSeq).toBe(2)
  })
})
