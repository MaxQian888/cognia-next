/**
 * Tests for lib/notifications/delivery/webhook-sender.ts — the send pass that
 * drains prepared/queued webhook intents. Covers the pending filter (notBefore/
 * expiresAt/nextAttemptAt/outboundJobId), the claim CAS, target-version
 * staleness (superseded, not sent), deleted/disabled/missing targets
 * (cancelled), the outcome→status map, retry backoff, the publication fold,
 * and the idempotent persist-by-operationKey.
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { upsertNotificationTarget } from "@/lib/db/notification-targets"
import { getDeliveryIntent } from "@/lib/db/notification-delivery"
import { getOrCreatePublication, getPublication } from "@/lib/db/notification-publications"
import { upsertNotificationSubscription } from "@/lib/db/notification-subscriptions"
import {
  sendPendingWebhookIntents,
  persistWebhookIntentInsideTransaction,
  prepareWebhookNotificationDelivery,
} from "./webhook-sender"
import type { FeishuWebhookDeps } from "./feishu-webhook"
import type { NotificationRenderedPayload } from "@/types/notifications/result"
import type { NotificationScope } from "@/types/notifications/scope"
import type { TauriHttpResponse } from "@/types/connectors/adapter"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => await dbFixture.restore())
afterAll(async () => await dbFixture.dispose())

const scope: NotificationScope = { namespaceId: "ns", accountId: "a", authorityHostId: "h" }

const payload: NotificationRenderedPayload = {
  title: "T",
  body: "B",
  level: "info",
  disclosureLevel: "public",
  clippedFactCount: 0,
  contentHash: "hash-1",
}

async function webhookTarget() {
  return upsertNotificationTarget({
    scope,
    label: "wh",
    address: { kind: "feishu-webhook", endpointSecretRef: "svc:acct", region: "feishu" },
    enabled: true,
    consent: { mode: "proactive", grantRef: "g", grantedBy: "a", grantedAt: 0 },
    disclosureProfileId: "public",
    locale: "en",
    timezone: "UTC",
  })
}

async function seedIntent(
  targetId: string,
  targetVersion: number,
  over: Record<string, unknown> = {}
) {
  const db = getDb()
  return db.transaction(
    "rw",
    [db.notificationDeliveryIntents, db.notificationTargets, db.notificationSubscriptions],
    async () =>
      persistWebhookIntentInsideTransaction(db, {
        target: {
          id: targetId,
          version: targetVersion,
          scope,
          address: { kind: "feishu-webhook", endpointSecretRef: "svc:acct", region: "feishu" },
        } as never,
        payload,
        purpose: "terminal-state",
        category: "run.terminal",
        operationKey: (over.operationKey as string) ?? `op-${Math.random()}`,
        expectedTargetVersion: targetVersion,
        ...over,
      })
  )
}

function deps(over: Partial<FeishuWebhookDeps> = {}): FeishuWebhookDeps {
  return {
    sendHttp:
      over.sendHttp ?? (async () => ({ status: 200, body: '{"code":0}' }) as TauriHttpResponse),
    resolveSecret: over.resolveSecret ?? (async () => "https://hook"),
    now: over.now ?? (() => 1_700_000_000_000),
    ...(over.hmacSha256Base64 ? { hmacSha256Base64: over.hmacSha256Base64 } : {}),
  }
}

function http(status: number, body: unknown): TauriHttpResponse {
  return {
    status,
    body: typeof body === "string" ? body : JSON.stringify(body),
  } as TauriHttpResponse
}

describe("sendPendingWebhookIntents", () => {
  it("sends a prepared webhook intent → accepted + one attempt", async () => {
    const t = await webhookTarget()
    const id = await seedIntent(t.id, t.version)
    const result = await sendPendingWebhookIntents({ deps: deps() })
    expect(result.sent).toBe(1)
    const stored = await getDeliveryIntent(id)
    expect(stored?.status).toBe("accepted")
    const attempts = await getDb()
      .notificationDeliveryAttempts.where("intentId")
      .equals(id)
      .toArray()
    expect(attempts).toHaveLength(1)
    expect(attempts[0].outcome).toBe("accepted")
  })

  it("skips an intent whose notBefore is in the future", async () => {
    const t = await webhookTarget()
    await seedIntent(t.id, t.version, { notBefore: Date.now() + 60_000 })
    const result = await sendPendingWebhookIntents({ deps: deps() })
    expect(result.scanned).toBe(0)
  })

  it("skips an intent whose outboundJobId is set (connector lane owns it)", async () => {
    const t = await webhookTarget()
    const db = getDb()
    const id = await seedIntent(t.id, t.version)
    await db.notificationDeliveryIntents.update(id, { outboundJobId: "job-x" })
    const result = await sendPendingWebhookIntents({ deps: deps() })
    expect(result.scanned).toBe(0)
  })

  it("cancels an intent whose target is deleted", async () => {
    const t = await webhookTarget()
    const id = await seedIntent(t.id, t.version)
    await getDb().notificationTargets.delete(t.id)
    await sendPendingWebhookIntents({ deps: deps() })
    expect((await getDeliveryIntent(id))?.status).toBe("cancelled")
  })

  it("cancels an intent whose target is disabled", async () => {
    const t = await webhookTarget()
    const id = await seedIntent(t.id, t.version)
    await getDb().notificationTargets.update(t.id, { enabled: false })
    await sendPendingWebhookIntents({ deps: deps() })
    expect((await getDeliveryIntent(id))?.status).toBe("cancelled")
  })

  it("supersedes an intent whose target version moved", async () => {
    const t = await webhookTarget()
    const id = await seedIntent(t.id, t.version)
    await upsertNotificationTarget({ ...t, id: t.id }) // bumps version
    await sendPendingWebhookIntents({ deps: deps() })
    expect((await getDeliveryIntent(id))?.status).toBe("superseded")
  })

  it("re-queues a retryable outcome with backoff", async () => {
    const t = await webhookTarget()
    const id = await seedIntent(t.id, t.version)
    const result = await sendPendingWebhookIntents({
      deps: deps({ sendHttp: async () => http(500, {}) }), // network-error → retryable
    })
    expect(result.retried).toBe(1)
    const stored = await getDeliveryIntent(id)
    expect(stored?.status).toBe("queued")
    expect(stored?.nextAttemptAt).toBeGreaterThan(Date.now())
  })

  it("fails a retryable outcome once out of attempts", async () => {
    const t = await webhookTarget()
    const db = getDb()
    const id = await seedIntent(t.id, t.version)
    await db.notificationDeliveryIntents.update(id, { attemptCount: 4, maxAttempts: 5 })
    await sendPendingWebhookIntents({ deps: deps({ sendHttp: async () => http(500, {}) }) })
    expect((await getDeliveryIntent(id))?.status).toBe("failed")
  })

  it("maps a platform refusal (invalid-target) to rejected", async () => {
    const t = await webhookTarget()
    const id = await seedIntent(t.id, t.version)
    await sendPendingWebhookIntents({ deps: deps({ sendHttp: async () => http(404, {}) }) })
    expect((await getDeliveryIntent(id))?.status).toBe("rejected")
  })

  it("maps a transport fault (timeout-unknown) to delivery-unknown — never blindly re-sent", async () => {
    const t = await webhookTarget()
    const id = await seedIntent(t.id, t.version)
    await sendPendingWebhookIntents({
      deps: deps({
        sendHttp: async () => {
          throw new Error("boom")
        },
      }),
    })
    expect((await getDeliveryIntent(id))?.status).toBe("delivery-unknown")
  })

  it("folds the platform receipt onto the publication on accept", async () => {
    const t = await webhookTarget()
    const pub = await getOrCreatePublication({
      scopeKey: "sk",
      notificationId: "n1",
      targetId: t.id,
      slotKey: "slot-1",
      purpose: "terminal-state",
      runTerminal: false,
      state: "open",
    })
    await seedIntent(t.id, t.version, { publicationId: pub.id })
    await sendPendingWebhookIntents({
      deps: deps({ sendHttp: async () => http(200, { code: 0, data: { message_id: "om_w" } }) }),
    })
    const stored = await getPublication(pub.id)
    expect(stored?.platformMessageId).toBe("om_w")
    expect(stored?.acceptedContentHash).toBe("hash-1")
  })
})

describe("persistWebhookIntentInsideTransaction", () => {
  const WEBHOOK_TX = (db: ReturnType<typeof getDb>) =>
    [db.notificationDeliveryIntents, db.notificationTargets, db.notificationSubscriptions] as const

  it("persists a prepared intent with the frozen payload", async () => {
    const t = await webhookTarget()
    const db = getDb()
    const id = await db.transaction("rw", WEBHOOK_TX(db), async () =>
      persistWebhookIntentInsideTransaction(db, {
        target: t,
        payload,
        purpose: "terminal-state",
        category: "run.terminal",
        operationKey: "op-uniq",
        expectedTargetVersion: t.version,
      })
    )
    const stored = await getDeliveryIntent(id)
    expect(stored?.status).toBe("prepared")
    expect(stored?.payload.clippedFactCount).toBe(0)
    expect(stored?.targetVersion).toBe(t.version)
  })

  it("is idempotent — same operationKey returns the existing id", async () => {
    const t = await webhookTarget()
    const db = getDb()
    const seed = {
      target: t,
      payload,
      purpose: "terminal-state",
      category: "run.terminal",
      operationKey: "op-same",
      expectedTargetVersion: t.version,
    } as const
    const a = await db.transaction("rw", WEBHOOK_TX(db), async () =>
      persistWebhookIntentInsideTransaction(db, seed)
    )
    const b = await db.transaction("rw", WEBHOOK_TX(db), async () =>
      persistWebhookIntentInsideTransaction(db, seed)
    )
    expect(b).toBe(a)
    expect(await db.notificationDeliveryIntents.count()).toBe(1)
  })

  it("denies a commit when the target version moved between prepare and commit", async () => {
    const t = await webhookTarget()
    const db = getDb()
    await expect(
      db.transaction("rw", WEBHOOK_TX(db), async () =>
        persistWebhookIntentInsideTransaction(db, {
          target: t,
          payload,
          purpose: "terminal-state",
          category: "run.terminal",
          operationKey: "op-moved",
          expectedTargetVersion: t.version + 1,
        })
      )
    ).rejects.toMatchObject({ name: "NotificationDeliveryRejection", code: "target-version-moved" })
  })

  it("denies a commit when the subscription was disabled between prepare and commit", async () => {
    const t = await webhookTarget()
    const db = getDb()
    const sub = await upsertNotificationSubscription({
      scope: t.scope,
      principalId: "p1",
      binding: { kind: "scope" },
      targetIds: [t.id],
      maxDisclosureProfileId: "internal",
      minLevel: "info",
      enabled: true,
      createdBy: "test",
    })
    await db.transaction("rw", WEBHOOK_TX(db), async () => {
      // Disable the subscription inside the commit tx — the persist must see
      // the moved version and reject rather than land a revoked route.
      const live = await db.notificationSubscriptions.get(sub.id)
      await db.notificationSubscriptions.put({
        ...live!,
        enabled: false,
        version: live!.version + 1,
      })
      await expect(
        persistWebhookIntentInsideTransaction(db, {
          target: t,
          payload,
          purpose: "terminal-state",
          category: "run.terminal",
          operationKey: "op-revoked",
          subscriptionId: sub.id,
          expectedTargetVersion: t.version,
          expectedSubscriptionVersion: sub.version,
        })
      ).rejects.toMatchObject({
        name: "NotificationDeliveryRejection",
        code: "subscription-version-moved",
      })
    })
  })
})

describe("prepareWebhookNotificationDelivery", () => {
  const base = (t: Awaited<ReturnType<typeof webhookTarget>>) => ({
    target: t,
    payload,
    purpose: "terminal-state" as const,
    category: "run.terminal" as const,
    operationKey: "op-prep",
  })

  it("freezes the target + subscription versions for commit-time revalidation", async () => {
    const t = await webhookTarget()
    const sub = await upsertNotificationSubscription({
      scope: t.scope,
      principalId: "p1",
      binding: { kind: "scope" },
      targetIds: [t.id],
      maxDisclosureProfileId: "internal",
      minLevel: "info",
      enabled: true,
      createdBy: "test",
    })
    const prepared = await prepareWebhookNotificationDelivery({
      ...base(t),
      subscriptionId: sub.id,
    })
    expect(prepared.expectedTargetVersion).toBe(t.version)
    expect(prepared.expectedSubscriptionVersion).toBe(sub.version)
  })

  it("runs the PII gate over the rendered payload — a leaking body is rejected", async () => {
    const t = await webhookTarget()
    // hasNoLeakingPiiDeep returns false when content leaks → pii-rejected.
    await expect(
      prepareWebhookNotificationDelivery({ ...base(t), piiGate: () => false })
    ).rejects.toMatchObject({ name: "NotificationDeliveryRejection", code: "pii-rejected" })
  })

  it("rejects a non-webhook target kind", async () => {
    const t = await webhookTarget()
    const connectorTarget = {
      ...t,
      address: { kind: "connector", adapterId: "feishu", deliveryTarget: {} },
    } as never
    await expect(
      prepareWebhookNotificationDelivery({ ...base(t), target: connectorTarget })
    ).rejects.toMatchObject({ name: "NotificationDeliveryRejection", code: "target-missing" })
  })

  it("rejects a disabled subscription", async () => {
    const t = await webhookTarget()
    const sub = await upsertNotificationSubscription({
      scope: t.scope,
      principalId: "p1",
      binding: { kind: "scope" },
      targetIds: [t.id],
      maxDisclosureProfileId: "internal",
      minLevel: "info",
      enabled: false,
      createdBy: "test",
    })
    await expect(
      prepareWebhookNotificationDelivery({ ...base(t), subscriptionId: sub.id })
    ).rejects.toMatchObject({
      name: "NotificationDeliveryRejection",
      code: "subscription-disabled",
    })
  })
})
