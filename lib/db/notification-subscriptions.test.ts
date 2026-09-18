/**
 * Tests for lib/db/notification-subscriptions.ts — the V2 subscription store.
 * Covers CAS-versioned upsert/delete, the enabled index, the targetIds
 * reverse lookup the revocation cascade reads, and scope isolation.
 *
 * Dexie runs on fake-indexeddb via createDbTestFixture (jsdom project).
 */

import { createDbTestFixture } from "./test-fixture"
import { scopeKeyOf, type NotificationScope } from "@/types/notifications/scope"
import {
  upsertNotificationSubscription,
  getNotificationSubscription,
  listEnabledNotificationSubscriptions,
  listNotificationSubscriptions,
  listSubscriptionsForTarget,
  deleteNotificationSubscription,
  type UpsertNotificationSubscriptionInput,
} from "./notification-subscriptions"

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
const SCOPE_KEY = scopeKeyOf(scope)

function input(
  over: Partial<UpsertNotificationSubscriptionInput> = {}
): UpsertNotificationSubscriptionInput {
  return {
    scope,
    principalId: over.principalId ?? "a",
    binding: over.binding ?? { kind: "scope" },
    targetIds: over.targetIds ?? ["t1"],
    maxDisclosureProfileId: over.maxDisclosureProfileId ?? "internal",
    minLevel: over.minLevel ?? "info",
    enabled: over.enabled ?? true,
    createdBy: over.createdBy ?? "test",
    ...(over.id ? { id: over.id } : {}),
    ...(over.categories ? { categories: over.categories } : {}),
    ...(over.purposes ? { purposes: over.purposes } : {}),
    ...(over.rules ? { rules: over.rules } : {}),
    ...(over.expectedVersion !== undefined ? { expectedVersion: over.expectedVersion } : {}),
  }
}

describe("upsertNotificationSubscription", () => {
  it("creates a subscription with scopeKey + enabledKey in lock-step", async () => {
    const row = await upsertNotificationSubscription(input())
    expect(row.id).toBeTruthy()
    expect(row.version).toBe(1)
    expect(row.scopeKey).toBe(SCOPE_KEY)
    expect(row.enabledKey).toBe(1)
    expect(row.createdBy).toBe("test")
  })

  it("a disabled subscription stores enabledKey 0", async () => {
    const row = await upsertNotificationSubscription(input({ enabled: false }))
    expect(row.enabledKey).toBe(0)
  })

  it("CAS update bumps version; a stale expectedVersion throws", async () => {
    const row = await upsertNotificationSubscription(input())
    const updated = await upsertNotificationSubscription(
      input({ id: row.id, expectedVersion: 1, minLevel: "warning" })
    )
    expect(updated.version).toBe(2)
    expect(updated.minLevel).toBe("warning")
    await expect(
      upsertNotificationSubscription(input({ id: row.id, expectedVersion: 1 }))
    ).rejects.toThrow("subscription-version-conflict")
  })

  it("preserves the original createdBy on update", async () => {
    const row = await upsertNotificationSubscription(input({ createdBy: "author" }))
    const updated = await upsertNotificationSubscription(
      input({ id: row.id, expectedVersion: 1, createdBy: "other" })
    )
    expect(updated.createdBy).toBe("author")
  })

  it("stores optional filters when present", async () => {
    const row = await upsertNotificationSubscription(
      input({ categories: ["run.terminal"], rules: [{ kind: "deny" }] })
    )
    expect(row.categories).toEqual(["run.terminal"])
    expect(row.rules).toEqual([{ kind: "deny" }])
  })
})

describe("subscription list queries", () => {
  it("listEnabledNotificationSubscriptions returns only enabled, non-deleted rows", async () => {
    await upsertNotificationSubscription(input({ principalId: "on" }))
    await upsertNotificationSubscription(input({ principalId: "off", enabled: false }))
    const enabled = await listEnabledNotificationSubscriptions(SCOPE_KEY)
    expect(enabled.map((s) => s.principalId)).toEqual(["on"])
  })

  it("listNotificationSubscriptions returns enabled AND disabled", async () => {
    await upsertNotificationSubscription(input())
    await upsertNotificationSubscription(input({ enabled: false }))
    expect(await listNotificationSubscriptions(SCOPE_KEY)).toHaveLength(2)
  })

  it("scopes queries by scopeKey — a foreign scope sees nothing", async () => {
    await upsertNotificationSubscription(input())
    expect(await listEnabledNotificationSubscriptions("other")).toHaveLength(0)
    expect(await listNotificationSubscriptions("other")).toHaveLength(0)
  })
})

describe("listSubscriptionsForTarget", () => {
  it("finds every subscription routing to a target (revocation cascade)", async () => {
    await upsertNotificationSubscription(input({ targetIds: ["t1", "t2"] }))
    await upsertNotificationSubscription(input({ targetIds: ["t2"] }))
    await upsertNotificationSubscription(input({ targetIds: ["t3"] }))
    const routes = await listSubscriptionsForTarget(SCOPE_KEY, "t2")
    expect(routes).toHaveLength(2)
  })

  it("ignores a deleted subscription that still references the target", async () => {
    const dead = await upsertNotificationSubscription(input({ targetIds: ["t9"] }))
    await deleteNotificationSubscription(dead.id)
    const routes = await listSubscriptionsForTarget(SCOPE_KEY, "t9")
    expect(routes).toHaveLength(0)
  })

  it("ignores a subscription in a foreign scope even on the same target id", async () => {
    await upsertNotificationSubscription(input({ targetIds: ["shared"] }))
    const routes = await listSubscriptionsForTarget("foreign-scope", "shared")
    expect(routes).toHaveLength(0)
  })
})

describe("getNotificationSubscription", () => {
  it("reads back the persisted row including the binding", async () => {
    const row = await upsertNotificationSubscription(
      input({ binding: { kind: "run", runId: "r7" } })
    )
    const found = await getNotificationSubscription(row.id)
    expect(found?.binding).toEqual({ kind: "run", runId: "r7" })
  })

  it("returns undefined for an unknown id", async () => {
    expect(await getNotificationSubscription("nope")).toBeUndefined()
  })
})

describe("deleteNotificationSubscription", () => {
  it("soft-deletes: row stays, leaves the enabled set, bumps version", async () => {
    const row = await upsertNotificationSubscription(input())
    await deleteNotificationSubscription(row.id)
    const gone = await getNotificationSubscription(row.id)
    expect(gone?.deletedAt).toBeGreaterThan(0)
    expect(gone?.enabled).toBe(false)
    expect(gone?.version).toBe(2)
    expect(await listEnabledNotificationSubscriptions(SCOPE_KEY)).toHaveLength(0)
  })

  it("CAS delete refuses a stale expectedVersion", async () => {
    const row = await upsertNotificationSubscription(input())
    await expect(deleteNotificationSubscription(row.id, 99)).rejects.toThrow(
      "subscription-version-conflict"
    )
  })
})
