/** @jest-environment jsdom */
// Coverage for the notifications CRUD module (ADR-0042, table v68): put/get,
// dedupe lookup, patch, listing/filter, badge counts, group lookup, retention
// pruning (TTL + age + cap), and delete/clear. fake-indexeddb exercises the
// real Dexie query path against in-memory IDB.

import "fake-indexeddb/auto"
import {
  putNotification,
  getNotification,
  findByDedupeKey,
  patchNotification,
  listNotifications,
  getBadgeCounts,
  listByGroupKey,
  deleteNotification,
  clearNotifications,
  pruneNotifications,
} from "./notifications"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"
import type { NotificationRecord } from "@/types/notifications"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function rec(over: Partial<NotificationRecord> = {}): NotificationRecord {
  const t = over.createdAt ?? 1000
  return {
    id: over.id ?? `n_${Math.random().toString(36).slice(2, 9)}`,
    source: over.source ?? "system",
    level: over.level ?? "info",
    title: over.title ?? "Title",
    body: over.body,
    createdAt: t,
    updatedAt: over.updatedAt ?? t,
    readState: over.readState ?? "unseen",
    snoozedUntil: over.snoozedUntil,
    dedupeKey: over.dedupeKey,
    groupKey: over.groupKey,
    count: over.count ?? 1,
    directed: over.directed ?? false,
    deliveredVia: over.deliveredVia ?? ["center"],
    expiresAt: over.expiresAt,
    href: over.href,
    actions: over.actions,
    sourceRef: over.sourceRef,
    pluginId: over.pluginId,
    icon: over.icon,
    meta: over.meta,
  }
}

describe("put / get", () => {
  it("inserts and reads back a record", async () => {
    const r = rec({ id: "a", title: "Hi" })
    await putNotification(r)
    expect((await getNotification("a"))?.title).toBe("Hi")
  })

  it("put replaces an existing record by id", async () => {
    await putNotification(rec({ id: "a", title: "One" }))
    await putNotification(rec({ id: "a", title: "Two" }))
    expect((await getNotification("a"))?.title).toBe("Two")
    expect(await getDb().notifications.count()).toBe(1)
  })

  it("returns undefined for a missing id", async () => {
    expect(await getNotification("nope")).toBeUndefined()
  })
})

describe("findByDedupeKey", () => {
  it("returns the newest non-done record with the key created at/after sinceMs", async () => {
    await putNotification(rec({ id: "old", dedupeKey: "k", createdAt: 100, updatedAt: 100 }))
    await putNotification(rec({ id: "new", dedupeKey: "k", createdAt: 200, updatedAt: 250 }))
    const hit = await findByDedupeKey("k", 150)
    expect(hit?.id).toBe("new")
  })

  it("ignores records older than sinceMs", async () => {
    await putNotification(rec({ id: "old", dedupeKey: "k", createdAt: 100 }))
    expect(await findByDedupeKey("k", 150)).toBeUndefined()
  })

  it("ignores done records", async () => {
    await putNotification(rec({ id: "d", dedupeKey: "k", createdAt: 200, readState: "done" }))
    expect(await findByDedupeKey("k", 150)).toBeUndefined()
  })

  it("returns undefined when no record matches", async () => {
    expect(await findByDedupeKey("missing", 0)).toBeUndefined()
  })
})

describe("patchNotification", () => {
  it("updates selected fields", async () => {
    await putNotification(rec({ id: "a", count: 1 }))
    await patchNotification("a", { count: 3, readState: "read" })
    const got = await getNotification("a")
    expect(got?.count).toBe(3)
    expect(got?.readState).toBe("read")
  })

  it("is a no-op for a missing id", async () => {
    await expect(patchNotification("ghost", { count: 9 })).resolves.toBeUndefined()
  })
})

describe("listNotifications", () => {
  beforeEach(async () => {
    await putNotification(rec({ id: "a", createdAt: 100, source: "scheduler" }))
    await putNotification(rec({ id: "b", createdAt: 300, source: "connector" }))
    await putNotification(rec({ id: "c", createdAt: 200, source: "scheduler", readState: "done" }))
  })

  it("returns newest-first and excludes done by default", async () => {
    const rows = await listNotifications()
    expect(rows.map((r) => r.id)).toEqual(["b", "a"])
  })

  it("includes done when asked", async () => {
    const rows = await listNotifications({ includeDone: true })
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "a"])
  })

  it("filters by source", async () => {
    const rows = await listNotifications({ source: "scheduler" })
    expect(rows.map((r) => r.id)).toEqual(["a"])
  })

  it("filters by readStates", async () => {
    const rows = await listNotifications({ includeDone: true, readStates: ["done"] })
    expect(rows.map((r) => r.id)).toEqual(["c"])
  })

  it("hides records snoozed past now", async () => {
    await putNotification(rec({ id: "s", createdAt: 400, snoozedUntil: 9999 }))
    const visible = await listNotifications({ hideSnoozedAfter: 1000 })
    expect(visible.map((r) => r.id)).not.toContain("s")
    const all = await listNotifications({ hideSnoozedAfter: 100000 })
    expect(all.map((r) => r.id)).toContain("s")
  })

  it("respects limit", async () => {
    expect((await listNotifications({ limit: 1 })).map((r) => r.id)).toEqual(["b"])
  })
})

describe("getBadgeCounts", () => {
  it("counts directed-unread and ambient-unseen, skipping snoozed and read/done", async () => {
    await putNotification(rec({ id: "d1", directed: true, readState: "unseen" }))
    await putNotification(rec({ id: "d2", directed: true, readState: "seen" }))
    await putNotification(rec({ id: "a1", directed: false, readState: "unseen" }))
    await putNotification(rec({ id: "r1", directed: true, readState: "read" }))
    await putNotification(
      rec({ id: "snz", directed: true, readState: "unseen", snoozedUntil: 9999 })
    )
    const counts = await getBadgeCounts(1000)
    expect(counts.directedUnread).toBe(2) // d1 + d2 (snz skipped, r1 is read)
    expect(counts.ambientUnseen).toBe(2) // d1 + a1 (unseen only)
  })

  it("returns zeros for an empty table", async () => {
    expect(await getBadgeCounts(0)).toEqual({ directedUnread: 0, ambientUnseen: 0 })
  })
})

describe("listByGroupKey", () => {
  it("returns all records sharing a groupKey", async () => {
    await putNotification(rec({ id: "g1", groupKey: "conv:1" }))
    await putNotification(rec({ id: "g2", groupKey: "conv:1" }))
    await putNotification(rec({ id: "g3", groupKey: "conv:2" }))
    const got = await listByGroupKey("conv:1")
    expect(got.map((r) => r.id).sort()).toEqual(["g1", "g2"])
  })
})

describe("delete / clear", () => {
  it("deletes a single record", async () => {
    await putNotification(rec({ id: "a" }))
    await deleteNotification("a")
    expect(await getNotification("a")).toBeUndefined()
  })

  it("clears the whole table", async () => {
    await putNotification(rec({ id: "a" }))
    await putNotification(rec({ id: "b" }))
    await clearNotifications()
    expect(await getDb().notifications.count()).toBe(0)
  })
})

describe("pruneNotifications", () => {
  it("drops TTL-expired records", async () => {
    await putNotification(rec({ id: "exp", expiresAt: 500 }))
    await putNotification(rec({ id: "live", expiresAt: 5000 }))
    const removed = await pruneNotifications({ now: 1000, maxAgeMs: 0, maxItems: 0 })
    expect(removed).toBe(1)
    expect(await getNotification("exp")).toBeUndefined()
    expect(await getNotification("live")).toBeDefined()
  })

  it("drops records older than maxAgeMs", async () => {
    await putNotification(rec({ id: "old", createdAt: 100 }))
    await putNotification(rec({ id: "fresh", createdAt: 900 }))
    const removed = await pruneNotifications({ now: 1000, maxAgeMs: 500, maxItems: 0 })
    expect(removed).toBe(1)
    expect(await getNotification("old")).toBeUndefined()
  })

  it("trims to the newest maxItems", async () => {
    for (let i = 0; i < 5; i++) {
      await putNotification(rec({ id: `n${i}`, createdAt: 100 + i }))
    }
    const removed = await pruneNotifications({ now: 10000, maxAgeMs: 0, maxItems: 2 })
    expect(removed).toBe(3)
    const remaining = (await listNotifications({ includeDone: true })).map((r) => r.id)
    expect(remaining.sort()).toEqual(["n3", "n4"])
  })

  it("returns 0 when nothing needs pruning", async () => {
    await putNotification(rec({ id: "a", createdAt: 900 }))
    expect(await pruneNotifications({ now: 1000, maxAgeMs: 0, maxItems: 0 })).toBe(0)
  })
})
