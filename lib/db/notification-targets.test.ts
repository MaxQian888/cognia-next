/**
 * Tests for lib/db/notification-targets.ts — the V2 delivery-target store.
 * Covers the canonical address fingerprint (two aliases → one destination),
 * the CAS version on upsert/delete, the enabled/[scopeKey+enabledKey] index,
 * the fingerprint alias query, and soft-delete revocation.
 *
 * Dexie runs on fake-indexeddb via createDbTestFixture (jsdom project).
 */

import { createDbTestFixture } from "./test-fixture"
import {
  notificationTargetFingerprint,
  upsertNotificationTarget,
  getNotificationTarget,
  listEnabledNotificationTargets,
  listNotificationTargets,
  listTargetsByFingerprint,
  deleteNotificationTarget,
  type UpsertNotificationTargetInput,
} from "./notification-targets"
import { scopeKeyOf, type NotificationScope } from "@/types/notifications/scope"
import type { ConversationDeliveryTarget } from "@/types/connectors/event"

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

// The scope's scopeKey is derived inside upsert — the list queries need the
// same encoded key, so compute it the same way the DB layer does.
const REAL_SCOPE_KEY = scopeKeyOf(scope)

function convTarget(containerId: string, topicId?: string): ConversationDeliveryTarget {
  return {
    address: {
      conversationKey: `ck-${containerId}`,
      platform: "feishu",
      adapterId: "ad-1",
      scopeKind: "group",
      containerId,
      ...(topicId ? { topicId } : {}),
    },
    conversationRef: { platform: "feishu", adapterId: "ad-1" },
    refreshedAt: 0,
  }
}

function connectorAddress(containerId: string, topicId?: string) {
  return {
    kind: "connector" as const,
    adapterId: "ad-1",
    region: "feishu" as const,
    deliveryTarget: convTarget(containerId, topicId),
  }
}

function webhookAddress(secretRef = "ref-1") {
  return {
    kind: "feishu-webhook" as const,
    endpointSecretRef: secretRef,
    region: "feishu" as const,
  }
}

function input(over: Partial<UpsertNotificationTargetInput> = {}): UpsertNotificationTargetInput {
  return {
    scope,
    label: over.label ?? "#alerts",
    address: over.address ?? webhookAddress(),
    enabled: over.enabled ?? true,
    consent: over.consent ?? {
      mode: "proactive",
      grantRef: "g1",
      grantedBy: "acct",
      grantedAt: 0,
    },
    disclosureProfileId: over.disclosureProfileId ?? "internal",
    locale: over.locale ?? "en",
    timezone: over.timezone ?? "UTC",
    ...(over.id ? { id: over.id } : {}),
    ...(over.expectedVersion !== undefined ? { expectedVersion: over.expectedVersion } : {}),
  }
}

describe("notificationTargetFingerprint", () => {
  it("an explicit conversationKey override is part of the destination identity", () => {
    const a = notificationTargetFingerprint(connectorAddress("chat-1"))
    const b = notificationTargetFingerprint({
      ...connectorAddress("chat-1"),
      conversationKey: "alias-2",
    })
    // The fingerprint folds `conversationKey` into the canonical destination,
    // so an override distinguishes the binding even on the same container.
    expect(a).not.toBe(b)
  })

  it("two rows naming the SAME connector address share the fingerprint", () => {
    expect(notificationTargetFingerprint(connectorAddress("chat-1"))).toBe(
      notificationTargetFingerprint(connectorAddress("chat-1"))
    )
  })

  it("different containers produce different fingerprints", () => {
    expect(notificationTargetFingerprint(connectorAddress("chat-1"))).not.toBe(
      notificationTargetFingerprint(connectorAddress("chat-2"))
    )
  })

  it("topic distinguishes two threads in one container", () => {
    expect(notificationTargetFingerprint(connectorAddress("chat-1", "t1"))).not.toBe(
      notificationTargetFingerprint(connectorAddress("chat-1", "t2"))
    )
  })

  it("webhook fingerprints the secret REFERENCE, never the URL", () => {
    const fp = notificationTargetFingerprint(webhookAddress("secret-ref-x"))
    expect(fp).toContain("secret-ref-x")
    expect(fp.startsWith("feishu-webhook:")).toBe(true)
    expect(notificationTargetFingerprint(webhookAddress("a"))).not.toBe(
      notificationTargetFingerprint(webhookAddress("b"))
    )
  })
})

describe("upsertNotificationTarget", () => {
  it("creates a target with a fingerprint + enabledKey in lock-step", async () => {
    const row = await upsertNotificationTarget(input())
    expect(row.id).toBeTruthy()
    expect(row.version).toBe(1)
    expect(row.enabled).toBe(true)
    expect(row.enabledKey).toBe(1)
    expect(row.scopeKey).toBe(REAL_SCOPE_KEY)
    expect(row.addressFingerprint).toBe(notificationTargetFingerprint(row.address))
  })

  it("a disabled target stores enabledKey 0", async () => {
    const row = await upsertNotificationTarget(input({ enabled: false }))
    expect(row.enabledKey).toBe(0)
  })

  it("CAS update bumps version; a stale expectedVersion throws", async () => {
    const row = await upsertNotificationTarget(input())
    const updated = await upsertNotificationTarget(
      input({ id: row.id, expectedVersion: 1, label: "new" })
    )
    expect(updated.version).toBe(2)
    expect(updated.label).toBe("new")
    await expect(
      upsertNotificationTarget(input({ id: row.id, expectedVersion: 1 }))
    ).rejects.toThrow("target-version-conflict")
  })

  it("an address change re-mints the fingerprint", async () => {
    const row = await upsertNotificationTarget(input({ address: webhookAddress("ref-a") }))
    const fpA = row.addressFingerprint
    const moved = await upsertNotificationTarget(
      input({ id: row.id, expectedVersion: 1, address: webhookAddress("ref-b") })
    )
    expect(moved.addressFingerprint).not.toBe(fpA)
  })
})

describe("target list queries", () => {
  it("listEnabledNotificationTargets returns only enabled, non-deleted rows", async () => {
    await upsertNotificationTarget(input({ label: "on" }))
    await upsertNotificationTarget(input({ label: "off", enabled: false }))
    const enabled = await listEnabledNotificationTargets(REAL_SCOPE_KEY)
    expect(enabled.map((t) => t.label)).toEqual(["on"])
  })

  it("listNotificationTargets returns enabled AND disabled rows", async () => {
    await upsertNotificationTarget(input({ label: "on" }))
    await upsertNotificationTarget(input({ label: "off", enabled: false }))
    const all = await listNotificationTargets(REAL_SCOPE_KEY)
    expect(all).toHaveLength(2)
  })

  it("listTargetsByFingerprint finds alias rows of one destination", async () => {
    const addr = connectorAddress("chat-9")
    await upsertNotificationTarget(input({ label: "A", address: addr }))
    await upsertNotificationTarget(input({ label: "B", address: addr }))
    const aliases = await listTargetsByFingerprint(
      REAL_SCOPE_KEY,
      notificationTargetFingerprint(addr)
    )
    expect(aliases).toHaveLength(2)
  })

  it("scopes the queries by scopeKey — a foreign scope sees nothing", async () => {
    await upsertNotificationTarget(input())
    expect(await listEnabledNotificationTargets("other-scope")).toHaveLength(0)
    expect(await listNotificationTargets("other-scope")).toHaveLength(0)
  })
})

describe("deleteNotificationTarget", () => {
  it("soft-deletes: row stays, leaves every candidate list, bumps version", async () => {
    const row = await upsertNotificationTarget(input())
    await deleteNotificationTarget(row.id)
    const gone = await getNotificationTarget(row.id)
    expect(gone?.deletedAt).toBeGreaterThan(0)
    expect(gone?.enabled).toBe(false)
    expect(gone?.version).toBe(2)
    expect(await listEnabledNotificationTargets(REAL_SCOPE_KEY)).toHaveLength(0)
    expect(await listNotificationTargets(REAL_SCOPE_KEY)).toHaveLength(0)
  })

  it("CAS delete refuses a stale expectedVersion", async () => {
    const row = await upsertNotificationTarget(input())
    await expect(deleteNotificationTarget(row.id, 99)).rejects.toThrow("target-version-conflict")
  })
})
