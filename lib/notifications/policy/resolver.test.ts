/**
 * Tests for lib/notifications/policy/resolver.ts — the DB→planner bridge.
 * Covers input gathering (enabled subscriptions, referenced targets, open
 * incidents, prior intents), the decision it returns, and the commit-time
 * route revalidation (a moved target/subscription version refuses the send).
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { upsertNotificationTarget } from "@/lib/db/notification-targets"
import { upsertNotificationSubscription } from "@/lib/db/notification-subscriptions"
import { resolveNotificationPlan, revalidateRouteAtCommit } from "./resolver"
import type { NotificationPolicyContext } from "@/types/notifications/decision"
import type { NotificationScope } from "@/types/notifications/scope"
import { scopeKeyOf } from "@/types/notifications/scope"
import type { PlannerFact } from "./planner"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => await dbFixture.restore())
afterAll(async () => await dbFixture.dispose())

const scope: NotificationScope = { namespaceId: "ns", accountId: "a", authorityHostId: "h" }
const SCOPE_KEY = scopeKeyOf(scope) // the stored scopeKey the subscription rows index on

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

function fact(over: Partial<PlannerFact> = {}): PlannerFact {
  return {
    factKey: "fact-1",
    category: "run.terminal",
    purpose: "terminal-state",
    level: "info",
    source: "execution",
    ...over,
  }
}

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

async function scopeSubscription(targetIds: string[]) {
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

describe("resolveNotificationPlan", () => {
  it("routes a fact to a scope-bound subscription's target", async () => {
    const t = await connectorTarget()
    await scopeSubscription([t.id])
    const decision = await resolveNotificationPlan({
      fact: fact(),
      scopeKey: SCOPE_KEY,
      policy,
      now: Date.now(),
    })
    expect(decision.outcome).toBe("notified")
    expect(decision.routes.some((r) => r.kind === "notified" && r.targetId === t.id)).toBe(true)
  })

  it("returns route-missing when no subscription binds the fact", async () => {
    const decision = await resolveNotificationPlan({
      fact: fact(),
      scopeKey: SCOPE_KEY,
      policy,
      now: Date.now(),
    })
    expect(decision.routes.every((r) => r.kind !== "notified")).toBe(true)
  })

  it("excludes disabled subscriptions from the plan", async () => {
    const t = await connectorTarget()
    await upsertNotificationSubscription({
      scope,
      principalId: "a",
      binding: { kind: "scope" },
      targetIds: [t.id],
      maxDisclosureProfileId: "public",
      minLevel: "info",
      enabled: false, // disabled → not gathered
      createdBy: "a",
    })
    const decision = await resolveNotificationPlan({
      fact: fact(),
      scopeKey: SCOPE_KEY,
      policy,
      now: Date.now(),
    })
    expect(decision.routes.every((r) => r.kind !== "notified")).toBe(true)
  })

  it("honors pre-resolved target overrides (batch callers)", async () => {
    const t = await connectorTarget()
    await scopeSubscription([t.id])
    const overrides = new Map([[t.id, t]])
    const decision = await resolveNotificationPlan({
      fact: fact(),
      scopeKey: SCOPE_KEY,
      policy,
      targetOverrides: overrides,
      now: Date.now(),
    })
    expect(decision.outcome).toBe("notified")
  })
})

describe("revalidateRouteAtCommit", () => {
  it("ok when target + subscription versions match", async () => {
    const t = await connectorTarget()
    const s = await scopeSubscription([t.id])
    const db = getDb()
    const result = await db.transaction(
      "r",
      [db.notificationTargets, db.notificationSubscriptions],
      async () =>
        revalidateRouteAtCommit({
          targetId: t.id,
          subscriptionId: s.id,
          expectedTargetVersion: t.version,
          expectedSubscriptionVersion: s.version,
          txDb: db,
        })
    )
    expect(result).toEqual({ ok: true })
  })

  it("refuses a target whose version moved", async () => {
    const t = await connectorTarget()
    const db = getDb()
    const result = await db.transaction("r", db.notificationTargets, async () =>
      revalidateRouteAtCommit({ targetId: t.id, expectedTargetVersion: t.version + 99, txDb: db })
    )
    expect(result).toEqual({ ok: false, reason: "target-version-moved" })
  })

  it("refuses a deleted target", async () => {
    const t = await connectorTarget()
    const db = getDb()
    await db.notificationTargets.update(t.id, { deletedAt: Date.now() })
    const result = await db.transaction("r", db.notificationTargets, async () =>
      revalidateRouteAtCommit({ targetId: t.id, expectedTargetVersion: t.version, txDb: db })
    )
    expect(result).toEqual({ ok: false, reason: "target-revoked" })
  })

  it("refuses a subscription whose version moved", async () => {
    const t = await connectorTarget()
    const s = await scopeSubscription([t.id])
    const db = getDb()
    const result = await db.transaction(
      "r",
      [db.notificationTargets, db.notificationSubscriptions],
      async () =>
        revalidateRouteAtCommit({
          targetId: t.id,
          subscriptionId: s.id,
          expectedTargetVersion: t.version,
          expectedSubscriptionVersion: s.version + 99,
          txDb: db,
        })
    )
    expect(result).toEqual({ ok: false, reason: "subscription-version-moved" })
  })
})
