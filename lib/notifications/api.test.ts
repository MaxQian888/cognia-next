/**
 * Tests for lib/notifications/api.ts — the operator/producer facade.
 * Covers the commit-first `emitNotification` (center record + planned external
 * intents in one commit), the dry-run `previewNotification` (no persistence),
 * the delivery diagnostics list/detail, and the operator retry/cancel actions.
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { upsertNotificationTarget } from "@/lib/db/notification-targets"
import { upsertNotificationSubscription } from "@/lib/db/notification-subscriptions"
import {
  emitNotification,
  previewNotification,
  listNotificationDeliveries,
  listNotificationDeliveriesForRun,
  getNotificationDeliveryDetail,
  retryNotificationDelivery,
  cancelNotificationDelivery,
} from "./api"
import type { NotificationScope } from "@/types/notifications/scope"

// The center write goes through the lazily-imported `./runtime` `notify`.
// Mock it to pass through to the real implementation EXCEPT when the marker
// title forces a throw — so a test can prove external intents persist even
// when the inbox write fails (the best-effort-center contract).
jest.mock("./runtime", () => {
  const actual = jest.requireActual<typeof import("./runtime")>("./runtime")
  return {
    ...actual,
    notify: jest.fn(async (input: { title?: string }) => {
      if (input.title === "__force_center_failure__") {
        throw new Error("forced center write failure")
      }
      return actual.notify(input as never)
    }),
  }
})

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => await dbFixture.restore())
afterAll(async () => await dbFixture.dispose())

const scope: NotificationScope = { namespaceId: "ns", accountId: "a", authorityHostId: "h" }

async function connectorTarget() {
  return upsertNotificationTarget({
    scope,
    label: "conn",
    address: {
      kind: "connector",
      adapterId: "feishu",
      deliveryTarget: { conversationRef: "c1", address: { conversationKey: "ck" } } as never,
      conversationKey: "ck",
    },
    enabled: true,
    consent: { mode: "proactive", grantRef: "g", grantedBy: "a", grantedAt: 0 },
    disclosureProfileId: "public",
    locale: "en",
    timezone: "UTC",
  })
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

async function scopeSub(targetIds: string[]) {
  return upsertNotificationSubscription({
    scope,
    principalId: "a",
    binding: { kind: "scope" },
    targetIds,
    maxDisclosureProfileId: "public",
    minLevel: "info",
    enabled: true,
    createdBy: "a",
  })
}

const emit = {
  category: "run.terminal" as const,
  purpose: "terminal-state" as const,
  level: "info" as const,
  source: "execution",
  title: "Deploy done",
  scopeHint: { accountId: "a", namespaceId: "ns" },
}

describe("emitNotification", () => {
  it("commits a governed intent for a connector target", async () => {
    const t = await connectorTarget()
    await scopeSub([t.id])
    const result = await emitNotification({ ...emit, logicalKey: "fact:c1" })
    expect(result.outcome).toBe("notified")
    expect(result.intentIds).toHaveLength(1)
    const intents = await getDb().notificationDeliveryIntents.toArray()
    expect(intents).toHaveLength(1)
    expect(intents[0].targetId).toBe(t.id)
    expect(intents[0].status).toBe("queued") // governed rides the outbound queue
    expect(intents[0].outboundJobId).toBeDefined()
    // The outbound job shares the operation key.
    const job = await getDb().outboundQueue.get(intents[0].outboundJobId!)
    expect(job?.notificationOperationKey).toBe(intents[0].operationKey)
  })

  it("commits a prepared webhook intent for a feishu-webhook target", async () => {
    const t = await webhookTarget()
    await scopeSub([t.id])
    const result = await emitNotification({ ...emit, logicalKey: "fact:w1" })
    expect(result.intentIds).toHaveLength(1)
    const intents = await getDb().notificationDeliveryIntents.toArray()
    expect(intents[0].status).toBe("prepared") // webhook lane sends it, not the queue
    expect(intents[0].outboundJobId).toBeUndefined()
  })

  it("is idempotent across a retry — the operation key collapses", async () => {
    const t = await connectorTarget()
    await scopeSub([t.id])
    await emitNotification({ ...emit, logicalKey: "fact:dup" })
    await emitNotification({ ...emit, logicalKey: "fact:dup" })
    expect(await getDb().notificationDeliveryIntents.count()).toBe(1)
    expect(await getDb().outboundQueue.count()).toBe(1)
  })

  it("commits no intent when no route subscribes the fact", async () => {
    const result = await emitNotification({ ...emit, logicalKey: "fact:none" })
    expect(result.intentIds).toHaveLength(0)
  })

  it("stamps the run source-ref + href on the center record when runId is given", async () => {
    const t = await connectorTarget()
    await scopeSub([t.id])
    await emitNotification({ ...emit, logicalKey: "run:r-9:terminal", runId: "r-9" })
    const record = await getDb()
      .notifications.where("logicalKey")
      .equals("run:r-9:terminal")
      .first()
    expect(record?.sourceRef).toEqual({ kind: "run", id: "r-9" })
    expect(record?.href).toBe("/agent-runs?run=r-9")
    expect(record?.groupKey).toBe("r-9")
  })

  it("still routes external delivery when the center write fails", async () => {
    const t = await connectorTarget()
    await scopeSub([t.id])
    // The marker title makes the mocked `notify` throw — the inbox is
    // best-effort so the durable external intent must still persist.
    const result = await emitNotification({
      ...emit,
      logicalKey: "fact:hardy",
      title: "__force_center_failure__",
    })
    expect(result.centerRecordId).toBeUndefined() // center write failed
    expect(result.intentIds).toHaveLength(1) // external intent committed anyway
    const intents = await getDb().notificationDeliveryIntents.toArray()
    expect(intents).toHaveLength(1)
    expect(intents[0].targetId).toBe(t.id)
  })

  it("lists every intent serving a run via its logical-key prefix", async () => {
    const t = await connectorTarget()
    await scopeSub([t.id])
    await emitNotification({ ...emit, logicalKey: "run:r-1:a", runId: "r-1" })
    await emitNotification({ ...emit, logicalKey: "run:r-1:b", runId: "r-1" })
    await emitNotification({ ...emit, logicalKey: "run:r-2:a", runId: "r-2" })
    const intents = await listNotificationDeliveriesForRun("r-1")
    expect(intents).toHaveLength(2)
    expect(intents.every((i) => i.logicalKey?.startsWith("run:r-1:"))).toBe(true)
  })

  it("folds an aggregate-ruled route into a digest bucket instead of an intent", async () => {
    const t = await connectorTarget()
    await upsertNotificationSubscription({
      scope,
      principalId: "a",
      binding: { kind: "scope" },
      targetIds: [t.id],
      maxDisclosureProfileId: "public",
      minLevel: "info",
      enabled: true,
      createdBy: "a",
      rules: [{ kind: "aggregate", aggregateKeyTemplate: "bucket:{category}" }],
    })
    const result = await emitNotification({ ...emit, logicalKey: "fact:digest" })
    // A digest route mints no intent — the fact folds into the bucket.
    expect(result.intentIds).toHaveLength(0)
    const members = await getDb().notificationAggregateMembers.toArray()
    expect(members.length).toBeGreaterThan(0)
  })
})

describe("previewNotification", () => {
  it("returns the decision + rendered payloads WITHOUT persisting intents", async () => {
    const t = await connectorTarget()
    await scopeSub([t.id])
    const { decision, payloads } = await previewNotification({ ...emit, logicalKey: "fact:p" })
    expect(decision.outcome).toBe("notified")
    expect(payloads).toHaveLength(1)
    expect(payloads[0].targetId).toBe(t.id)
    // The `public` profile clips the producer title to the generic privacy
    // title — the disclosure ceiling is applied at render.
    expect(payloads[0].payload.title).toBe("A run notification")
    expect(payloads[0].payload.disclosureLevel).toBe("public")
    // Dry run — nothing persisted.
    expect(await getDb().notificationDeliveryIntents.count()).toBe(0)
    expect(await getDb().outboundQueue.count()).toBe(0)
  })
})

describe("diagnostics + operator actions", () => {
  it("lists intents for a fact's logical key", async () => {
    const t = await connectorTarget()
    await scopeSub([t.id])
    await emitNotification({ ...emit, logicalKey: "fact:diag" })
    const intents = await listNotificationDeliveries("fact:diag")
    expect(intents).toHaveLength(1)
  })

  it("returns the intent + its attempt history", async () => {
    const t = await connectorTarget()
    await scopeSub([t.id])
    const { intentIds } = await emitNotification({ ...emit, logicalKey: "fact:d2" })
    const detail = await getNotificationDeliveryDetail(intentIds[0])
    expect(detail?.intent.id).toBe(intentIds[0])
    expect(detail?.attempts).toEqual([])
  })

  it("returns undefined detail for a missing intent", async () => {
    expect(await getNotificationDeliveryDetail("nope")).toBeUndefined()
  })

  it("operator-retries a terminal intent back to queued", async () => {
    const t = await connectorTarget()
    await scopeSub([t.id])
    const { intentIds } = await emitNotification({ ...emit, logicalKey: "fact:r" })
    await getDb().notificationDeliveryIntents.update(intentIds[0], { status: "failed" })
    const retried = await retryNotificationDelivery(intentIds[0])
    expect(retried?.status).toBe("queued")
  })

  it("refuses to retry a live (non-terminal) intent", async () => {
    const t = await connectorTarget()
    await scopeSub([t.id])
    const { intentIds } = await emitNotification({ ...emit, logicalKey: "fact:r2" })
    // The intent is `queued` (live) — retry must NOT touch it.
    const retried = await retryNotificationDelivery(intentIds[0])
    expect(retried).toBeUndefined()
  })

  it("operator-cancels a queued intent", async () => {
    const t = await connectorTarget()
    await scopeSub([t.id])
    const { intentIds } = await emitNotification({ ...emit, logicalKey: "fact:c" })
    const cancelled = await cancelNotificationDelivery(intentIds[0])
    expect(cancelled?.status).toBe("cancelled")
  })
})
